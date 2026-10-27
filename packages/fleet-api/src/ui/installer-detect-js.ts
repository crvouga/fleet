/** Browser hints describe the current computer; a Mac's Intel UA is ambiguous. */
export const INSTALLER_DETECT_JS = String.raw`
  function machine(hints) {
    var ua = navigator.userAgent || '';
    var platform = (hints && hints.platform) || navigator.platform || '';
    if ((hints && hints.mobile) || /Android|iPhone|iPad|iPod|CrOS/i.test(ua) ||
        (/Mac/i.test(platform) && navigator.maxTouchPoints > 1)) return { os: '', arch: '' };
    var os = /NixOS/i.test(ua + platform) ? 'nixos' :
      /Windows|Win32|Win64/i.test(platform + ua) ? 'windows' :
      /macOS|Macintosh|MacIntel|MacPPC/i.test(platform + ua) ? 'macos' :
      /Linux/i.test(platform + ua) ? 'linux' : '';
    var architecture = hints && hints.architecture;
    var bits = hints && hints.bitness;
    if (bits === '32' && !(hints && hints.wow64)) return { os: os, arch: 'unsupported' };
    var arch = /^(arm64|aarch64)$/i.test(architecture || '') || (architecture === 'arm' && bits === '64') ? 'arm64' :
      /^(x86_64|amd64)$/i.test(architecture || '') || (architecture === 'x86' && (bits === '64' || hints.wow64)) ? 'x64' : '';
    if (!arch && /aarch64|arm64/i.test(ua + platform)) arch = 'arm64';
    if (!arch && os !== 'macos' && /x86_64|amd64|Win64|WOW64|x64/i.test(ua + platform)) arch = 'x64';
    return { os: os, arch: arch };
  }

  function machineMessage(found) {
    if (found.os === 'macos') return 'Detected macOS. Your browser did not reveal the Mac chip. Choose Apple silicon or Intel below.';
    if (found.os === 'linux') return 'Detected Linux. Choose x64, ARM64, or the native NixOS installer below.';
    if (found.os === 'windows') return 'No matching native Windows download was detected. Choose an installer below or use another supported computer to make a USB.';
    return 'This browser did not identify a supported desktop computer. Choose an installer for the computer that will run it below.';
  }
`;
