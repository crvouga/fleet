// Drives the real wizard page in a real browser, end to end.
//   PLAYWRIGHT_PATH=/path/to/node_modules/playwright node ui-e2e.cjs
// The "USB stick" is a plain file, the disks come from a JSON file, and the
// helper is the real helper process, so every layer runs except the OS prompt.
'use strict';
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const MAIN = path.join(__dirname, 'main.py');
const PYTHON =
  process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

function fakeIso() {
  const blob = Buffer.alloc(96 * 1024, 7);
  blob.write('CD001', 32769, 'latin1');
  return blob;
}

// Every wizard this script starts, so a failure or timeout still stops them.
const children = new Set();
const started = Date.now();
let current = 'starting the browser';
// Name each scenario as it starts: a CI log then shows where time went, and a
// hang names its scenario instead of running silently until the job limit.
function scenario(name) {
  current = name;
  console.log(
    '[ui-e2e +' + ((Date.now() - started) / 1000).toFixed(1) + 's] ' + name
  );
}
const LIMIT_MS = Number(process.env.FLEET_UI_E2E_TIMEOUT_MS || 150000);
setTimeout(() => {
  console.error('UI E2E TIMEOUT after ' + LIMIT_MS / 1000 + 's in: ' + current);
  for (const child of children) child.kill('SIGKILL');
  process.exit(1);
}, LIMIT_MS).unref();
function within(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(resolve, ms).unref()),
  ]);
}

function startWizard(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ['-u', MAIN, '--no-browser'], {
      env: { ...process.env, ...env },
    });
    children.add(child);
    child.on('exit', () => children.delete(child));
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('wizard did not start with ' + PYTHON + ': ' + out));
    }, 20000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?t=\S+/);
      if (match) {
        clearTimeout(timer);
        resolve({ child, url: match[0] });
      }
    });
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('wizard exited ' + code + ': ' + out));
    });
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ui-'));
  const iso = fakeIso();
  const sha = crypto.createHash('sha256').update(iso).digest('hex');
  fs.mkdirSync(path.join(dir, 'release'));
  fs.writeFileSync(path.join(dir, 'release', 'fleet-installer.iso'), iso);
  fs.writeFileSync(
    path.join(dir, 'release', 'fleet-installer.iso.sha256'),
    `${sha}  fleet-installer.iso\n`
  );
  const usb = {
    path: '/dev/sdz',
    tran: 'usb',
    rm: true,
    hotplug: true,
    usb: true,
    internal: false,
    mounted: false,
    whole: true,
    size: 8e9,
    model: 'UI Test Stick',
    serial: 'UI1',
  };
  fs.writeFileSync(path.join(dir, 'disks.json'), JSON.stringify([usb]));
  const stick = path.join(dir, 'stick.img');
  fs.writeFileSync(stick, Buffer.alloc(iso.length + 4096, 0xee));
  const fileUrl = (name) =>
    require('node:url').pathToFileURL(path.join(dir, 'release', name)).href;
  const env = {
    FLEET_STATE: path.join(dir, 'state'),
    FLEET_CACHE: path.join(dir, 'cache'),
    FLEET_ELEVATE: 'none',
    FLEET_INSTALLER_URL: fileUrl('fleet-installer.iso'),
    FLEET_INSTALLER_SHA256_URL: fileUrl('fleet-installer.iso.sha256'),
    FLEET_DISKS_FILE: path.join(dir, 'disks.json'),
    FLEET_WRITE_TARGET: stick,
    FLEET_ARCH: 'x86_64',
    FLEET_NODE_CONF: path.join(dir, 'none.conf'),
    PYTHONIOENCODING: 'utf-8',
  };

  const browser = await chromium.launch();
  const failures = [];
  try {
    // ---- the golden path: make an install USB ---------------------------------
    scenario('make an install USB');
    {
      const { child, url } = await startWizard(env);
      const page = await browser.newPage();
      const dialogs = [];
      page.on('dialog', async (d) => {
        dialogs.push(d.message());
        await d.dismiss();
      });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(url);
      await page
        .getByText('What do you want to do?')
        .waitFor({ timeout: 30000 });
      assert.equal(
        await page.url().includes('t='),
        false,
        'the secret is removed from the address bar'
      );
      await page.reload();
      await page.getByText('What do you want to do?').waitFor();
      await page.getByRole('button', { name: /Make an install USB/ }).click();
      await page.getByText('UI Test Stick').waitFor();
      assert.equal(
        await page.locator('input[name="usb"]').isChecked(),
        true,
        'the only USB is selected automatically, with review still required'
      );
      await page.getByRole('button', { name: 'Review' }).click();
      await page.getByRole('button', { name: 'Erase and install' }).waitFor();
      assert.ok(
        (await page.locator('body').innerText()).includes('UI Test Stick'),
        'the review names the disk'
      );
      await page.getByRole('button', { name: 'Erase and install' }).click();
      assert.ok(
        dialogs.some((m) => m.includes('Tick the box')),
        'erasing without the tick is refused'
      );
      assert.deepEqual(
        fs.readFileSync(stick).subarray(0, 64),
        Buffer.alloc(64, 0xee),
        'nothing was written yet'
      );
      await page.locator('#ack').check();
      await page.getByRole('button', { name: 'Erase and install' }).click();
      await page
        .getByRole('heading', { name: 'USB ready' })
        .waitFor({ timeout: 60000 });
      assert.ok(
        (await page.locator('body').innerText()).includes(
          'start it from the stick'
        ),
        'next steps are shown'
      );
      assert.ok(
        fs.readFileSync(stick).subarray(0, iso.length).equals(iso),
        'the stick holds the installer'
      );
      assert.deepEqual(errors, [], 'no script errors');
      await page.close();
      child.kill();
    }

    // ---- this computer: review installs base, no role choice -----------------
    scenario('in-place review and Report a problem');
    {
      const internal = {
        ...usb,
        path: '/dev/nvme0n1',
        tran: 'nvme',
        usb: false,
        rm: false,
        hotplug: false,
        internal: true,
        mounted: true,
        size: 500e9,
        model: 'Test internal SSD',
        serial: 'I1',
      };
      fs.writeFileSync(
        path.join(dir, 'disks.json'),
        JSON.stringify([internal, usb])
      );
      const { child, url } = await startWizard({
        ...env,
        FLEET_OS: 'Linux',
        FLEET_KEXEC: PYTHON,
        FLEET_EFI_DIR: dir,
        FLEET_ISO_FS: 'ext4',
      });
      const page = await browser.newPage();
      await page.goto(url);
      await page.getByRole('button', { name: /Turn THIS computer/ }).click();
      assert.equal(
        await page.locator('input[name="role"]').count(),
        0,
        'the installer offers no role choice'
      );
      await page.getByRole('button', { name: 'Review' }).click();
      await page.getByRole('button', { name: 'Erase and install' }).waitFor();
      await page.getByText(/Automatic checks \(/).click();
      const review = await page.locator('body').innerText();
      assert.ok(
        review.includes('installs a Fleet node'),
        'review says it installs a Fleet node'
      );
      assert.ok(
        review.includes('Test internal SSD'),
        'review names the internal disk'
      );
      assert.ok(
        review.includes('What happens next') &&
          review.includes('FLEET INSTALLER') &&
          review.includes('Step 5 erases this disk'),
        'review explains every screen after the restart before anything is erased'
      );
      // Reporting works from any step, not only after a failure. The tab is a
      // stand-in that records its address: a real popup, its navigation and
      // its close hung intermittently on CI runners with no timeout to stop it.
      await page.evaluate(() => {
        window.openedIssues = [];
        window.open = () => ({
          opener: window,
          location: {
            set href(value) {
              window.openedIssues.push(value);
            },
          },
        });
      });
      await page.getByRole('button', { name: 'Report a problem' }).click();
      await page.waitForFunction(() => window.openedIssues.length > 0, null, {
        timeout: 15000,
      });
      const issueUrl = await page.evaluate(() => window.openedIssues[0]);
      assert.ok(
        issueUrl.startsWith('https://github.com/crvouga/fleet/issues/new?'),
        issueUrl
      );
      const query = new URL(issueUrl).searchParams;
      assert.equal(query.get('template'), 'fleet-installer.yml');
      assert.match(
        query.get('step') || '',
        /^Wizard on Linux: set up this computer/
      );
      assert.match(query.get('diagnostic') || '', /Fleet installer diagnostic/);
      await page.close();
      child.kill();
    }

    // ---- the release is not published: say so plainly -----------------------
    scenario('release not published');
    {
      const bad = {
        ...env,
        FLEET_INSTALLER_URL: require('node:url').pathToFileURL(
          path.join(dir, 'missing.iso')
        ).href,
      };
      const { child, url } = await startWizard(bad);
      const page = await browser.newPage();
      await page.goto(url);
      await page.getByText('cannot be reached').waitFor({ timeout: 30000 });
      assert.ok(
        await page.getByRole('button', { name: 'Try again' }).isVisible()
      );
      assert.equal(
        await page.getByRole('button', { name: /Make an install USB/ }).count(),
        0,
        'no way to continue'
      );
      await page.close();
      child.kill();
    }

    // ---- no USB stick plugged in: explained, with a way forward ------------
    scenario('no USB stick');
    {
      fs.writeFileSync(path.join(dir, 'disks.json'), JSON.stringify([]));
      const { child, url } = await startWizard(env);
      const page = await browser.newPage();
      await page.goto(url);
      await page.getByRole('button', { name: /Make an install USB/ }).click();
      await page.getByText('No USB stick found').waitFor();
      assert.ok(
        await page.getByRole('button', { name: 'Review' }).isDisabled(),
        'Review is disabled with no stick'
      );
      assert.ok(await page.getByRole('button', { name: 'Rescan' }).isVisible());
      await page.close();
      child.kill();
    }
  } catch (error) {
    failures.push(error);
  } finally {
    scenario('closing');
    for (const child of children) child.kill('SIGKILL');
    await within(browser.close(), 15000);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error('UI E2E FAIL', failures[0]);
    process.exit(1);
  }
  console.log('UI E2E OK');
}

main();
