import { INSTALLER_DETECT_JS } from './installer-detect-js';

/** Same-origin progressive enhancement; never downloads or redirects on load. */
export const INSTALLER_JS = `(function () {
  'use strict';
  var chosen = '';
  ${INSTALLER_DETECT_JS}
  function enhanceInstaller() {
    var box = document.getElementById('installer-downloads');
    if (!box || box.dataset.installerReady) return;
    box.dataset.installerReady = 'yes';
    var select = box.querySelector('select');
    var status = box.querySelector('[data-installer-status]');
    var link = box.querySelector('[data-installer-recommended]');
    var manual = Boolean(chosen);
    var latestHints;

    function openNixos() {
      var instructions = document.getElementById('nixos-install');
      if (instructions) instructions.open = true;
    }

    function render(id, message) {
      var option = Array.prototype.find.call(select.options, function (item) { return item.value === id && id; });
      link.hidden = !option;
      select.value = option ? id : '';
      status.textContent = message;
      if (!option) { link.removeAttribute('href'); return; }
      link.href = option.getAttribute('data-url');
      link.textContent = id === 'nixos' ? 'Open native NixOS installer instructions' : 'Download for ' + option.textContent.trim();
      if (id === 'nixos') openNixos();
    }

    function recommend(hints) {
      latestHints = hints;
      var detected = machine(hints);
      if (manual) return;
      var id = detected.os === 'nixos' ? 'nixos' : detected.os + '-' + detected.arch;
      var option = Array.prototype.find.call(select.options, function (item) { return item.value === id; });
      render(id, option ? 'Recommended for this computer: ' + option.textContent.trim() + '.' : machineMessage(detected));
    }

    select.addEventListener('change', function () {
      chosen = select.value;
      manual = Boolean(select.value);
      if (!manual) { recommend(latestHints); return; }
      render(select.value, 'Selected installer: ' + select.selectedOptions[0].textContent.trim() + '.');
    });
    box.querySelector('[data-installer-controls]').hidden = false;
    box.addEventListener('click', function (event) {
      if (event.target.closest && event.target.closest('[data-installer-nixos], [data-installer-recommended][href="#nixos-install"]')) openNixos();
    });
    var data = navigator.userAgentData;
    latestHints = data;
    if (manual) {
      select.value = chosen;
      render(chosen, 'Selected installer: ' + select.selectedOptions[0].textContent.trim() + '.');
    }
    if (data && data.getHighEntropyValues) {
      if (!manual) status.textContent = 'Detecting this computer…';
      Promise.race([
        Promise.resolve().then(function () { return data.getHighEntropyValues(['architecture', 'bitness', 'wow64']); }),
        new Promise(function (resolve) { setTimeout(function () { resolve(data); }, 800); })
      ]).then(function (hints) { recommend(hints); }).catch(function () { recommend(data); });
    } else recommend(data);
  }
  enhanceInstaller();
  document.addEventListener('fleet:updated', enhanceInstaller);
})();
`;
