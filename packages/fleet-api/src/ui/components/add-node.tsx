import { ACTIVE_ROLES, type ActiveRole } from '../../types';
import { Icon } from './icon';
import { NixosInstall } from './nixos-install';
import { InstallerDownloads } from './installer-downloads';

const ROLE_HELP: Record<ActiveRole, string> = {
  ci: 'GitHub Actions runners',
  devbox: 'a developer workstation',
};

interface Step {
  readonly title: string;
  readonly body: string;
}

const STEPS: readonly Step[] = [
  {
    title: 'Download the installer',
    body: 'Use the recommended download below, or choose the computer you are preparing an installer for.',
  },
  {
    title: 'Run it on the machine',
    body: 'Open the file. It checks the hardware and asks before it changes anything.',
  },
  {
    title: 'Choose a role',
    body: 'Pick what the machine is for. You can see the roles below.',
  },
  {
    title: 'Press Submit new issue',
    body: 'The installer opens a prefilled GitHub issue. Submitting it asks to join the fleet. Then approve the machine under Pending.',
  },
];

/** The exact steps to enrol a machine. Used on the empty overview and /add. */
export function AddNodeSteps(props: { heading: 'h1' | 'h2'; title: string }) {
  const Heading = props.heading;
  const Step = props.heading === 'h1' ? 'h2' : 'h3';
  return (
    <section class="card card-pad" aria-labelledby="add-node-title">
      <div class="flex items-start gap-3">
        <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent-ink">
          <Icon name="server" class="size-5" />
        </span>
        <div>
          <Heading
            id="add-node-title"
            class="text-xl font-semibold tracking-tight"
          >
            {props.title}
          </Heading>
          <p class="mt-1 max-w-prose text-fg-2">
            A node is a physical machine you own. It sends a short report every
            minute, and this page shows how it is doing.
          </p>
        </div>
      </div>
      <ol class="mt-6 grid gap-4 sm:grid-cols-2">
        {STEPS.map((step, index) => (
          <li key={step.title} class="flex gap-3">
            <span class="tabular grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold text-fg-2">
              {index + 1}
            </span>
            <div>
              <Step class="font-medium">{step.title}</Step>
              <p class="mt-0.5 text-fg-2">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <dl class="mt-6 grid gap-x-6 gap-y-1.5 rounded-lg bg-muted p-4 text-sm sm:grid-cols-2">
        {ACTIVE_ROLES.map((role) => (
          <div key={role} class="flex gap-2">
            <dt class="w-16 font-medium">{role}</dt>
            <dd class="text-fg-2">{ROLE_HELP[role]}</dd>
          </div>
        ))}
      </dl>
      <InstallerDownloads />
      <div class="mt-3">
        <a class="text-sm" href="/pending">
          Already ran it? See pending approvals
        </a>
      </div>
      <NixosInstall />
    </section>
  );
}
