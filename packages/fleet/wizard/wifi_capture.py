"""Read the currently connected Wi-Fi profile, without logging secrets.

Windows uses the WLAN API, never localized netsh output or exported XML files.
Enterprise profiles/certificates are not silently converted into personal Wi-Fi.
"""
import os
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

from fleet_wifi import WifiError, require


def output(args):
    try:
        done = subprocess.run(args, capture_output=True, text=True, timeout=20, check=False,
                              env={**os.environ, "LC_ALL": "C"})
    except (OSError, subprocess.TimeoutExpired):
        raise WifiError("Saved Wi-Fi settings could not be read. Enter the network settings in the wizard before installing.") from None
    require(done.returncode == 0, "Saved Wi-Fi settings could not be read. Enter the network settings in the wizard before installing.")
    return done.stdout.rstrip("\r\n")


def linux():
    if not shutil.which("nmcli"):
        active = any((p / "operstate").read_text().strip() == "up"
                     for p in Path("/sys/class/net").iterdir() if (p / "wireless").exists())
        require(not active, "This Wi-Fi connection cannot be exported automatically. Enter the Wi-Fi settings in the wizard before installing.")
        return None
    active = output(["nmcli", "--terse", "--escape", "no", "--fields", "UUID,TYPE", "connection", "show", "--active"])
    for line in active.splitlines():
        identifier, _, kind = line.partition(":")
        if kind not in ("802-11-wireless", "wifi"):
            continue
        require(re.fullmatch(r"[0-9a-fA-F-]{36}", identifier) is not None, "The active Wi-Fi profile has an invalid identity.")
        def get(field):
            return output(["nmcli", "--show-secrets", "--escape", "no", "--get-values", field, "connection", "show", "uuid", identifier])
        auth = get("802-11-wireless-security.key-mgmt")
        require(auth in ("", "--", "wpa-psk", "sae"), "This network uses enterprise or unsupported Wi-Fi security. Enter a supported network in the wizard before installing.")
        return {"ssid": get("802-11-wireless.ssid"), "auth": auth if auth not in ("", "--") else "open",
                "password": get("802-11-wireless-security.psk") if auth in ("wpa-psk", "sae") else "",
                "hidden": get("802-11-wireless.hidden") == "yes"}
    return None


def windows_xml(text):
    try:
        require(len(text) <= 65536, "The saved Wi-Fi profile is too large.")
        root = ET.fromstring(text)
        def value(path):
            return root.findtext("/".join("{*}" + part for part in path.split("/")), "")
        auth = value("MSM/security/authEncryption/authentication")
        modes = {"open": "open", "WPAPSK": "wpa-psk", "WPA2PSK": "wpa-psk", "WPA3SAE": "sae"}
        require(auth in modes and value("MSM/security/authEncryption/useOneX").lower() != "true",
                "This Wi-Fi profile needs enterprise credentials. Enter a supported network in the wizard before installing.")
        require(value("MSM/security/sharedKey/protected").lower() != "true",
                "Windows did not release a reusable Wi-Fi key. Enter the Wi-Fi settings in the wizard before installing.")
        hexadecimal = value("SSIDConfig/SSID/hex")
        ssid = bytes.fromhex(hexadecimal).decode("utf-8") if hexadecimal else value("SSIDConfig/SSID/name")
        return {"ssid": ssid, "password": value("MSM/security/sharedKey/keyMaterial"),
                "auth": modes[auth], "hidden": value("SSIDConfig/nonBroadcast").lower() == "true"}
    except (ET.ParseError, ValueError, UnicodeError):
        raise WifiError("The saved Windows Wi-Fi profile could not be decoded.") from None


def windows(name_only=False):
    import ctypes as c
    from ctypes import wintypes as w

    class GUID(c.Structure):
        _fields_ = [("data", c.c_byte * 16)]

    class Interface(c.Structure):
        _fields_ = [("guid", GUID), ("description", w.WCHAR * 256), ("state", w.DWORD)]

    api = c.WinDLL("wlanapi.dll")
    handle, version = w.HANDLE(), w.DWORD()
    api.WlanOpenHandle.argtypes = [w.DWORD, c.c_void_p, c.POINTER(w.DWORD), c.POINTER(w.HANDLE)]
    api.WlanEnumInterfaces.argtypes = [w.HANDLE, c.c_void_p, c.POINTER(c.c_void_p)]
    api.WlanQueryInterface.argtypes = [w.HANDLE, c.POINTER(GUID), w.DWORD, c.c_void_p, c.POINTER(w.DWORD), c.POINTER(c.c_void_p), c.POINTER(w.DWORD)]
    api.WlanGetProfile.argtypes = [w.HANDLE, c.POINTER(GUID), w.LPCWSTR, c.c_void_p, c.POINTER(c.c_void_p), c.POINTER(w.DWORD), c.POINTER(w.DWORD)]
    api.WlanFreeMemory.argtypes = [c.c_void_p]
    api.WlanCloseHandle.argtypes = [w.HANDLE, c.c_void_p]
    opened = api.WlanOpenHandle(2, None, c.byref(version), c.byref(handle))
    if opened == 1062:  # WLAN AutoConfig is stopped: usually wired-only hardware.
        return None
    require(opened == 0, "Windows Wi-Fi settings are unavailable. Enter the network settings in the wizard before installing.")
    interfaces = c.c_void_p()
    try:
        require(api.WlanEnumInterfaces(handle, None, c.byref(interfaces)) == 0, "Windows could not enumerate Wi-Fi adapters.")
        count = c.cast(interfaces, c.POINTER(w.DWORD))[0]
        require(count <= 64, "Windows reported an invalid Wi-Fi adapter list.")
        for index in range(count):
            interface = Interface.from_address(interfaces.value + 8 + index * c.sizeof(Interface))
            if interface.state != 1:  # wlan_interface_state_connected
                continue
            current, size, kind = c.c_void_p(), w.DWORD(), w.DWORD()
            require(api.WlanQueryInterface(handle, c.byref(interface.guid), 7, None, c.byref(size), c.byref(current), c.byref(kind)) == 0,
                    "Windows could not read the active Wi-Fi connection.")
            try:
                require(size.value >= 520, "Windows returned incomplete Wi-Fi connection data.")
                name = c.wstring_at(current.value + 8, 256).split("\0", 1)[0]
            finally:
                api.WlanFreeMemory(current)
            if name_only:
                return name
            profile, flags, access = c.c_void_p(), w.DWORD(4), w.DWORD()
            require(api.WlanGetProfile(handle, c.byref(interface.guid), name, None, c.byref(profile), c.byref(flags), c.byref(access)) == 0,
                    "Windows did not release the Wi-Fi key. Enter the network settings in the wizard before installing.")
            try:
                return windows_xml(c.wstring_at(profile))
            finally:
                api.WlanFreeMemory(profile)
        return None
    finally:
        if interfaces.value:
            api.WlanFreeMemory(interfaces)
        api.WlanCloseHandle(handle, None)


def darwin():
    if not shutil.which("networksetup"):
        return None
    ports = output(["networksetup", "-listallhardwareports"])
    match = re.search(r"Hardware Port: (?:Wi-Fi|AirPort)\nDevice: ([A-Za-z0-9]+)", ports)
    if not match:
        return None
    network = output(["networksetup", "-getairportnetwork", match[1]])
    if ": " not in network:
        return None
    ssid = network.split(": ", 1)[1]
    password = output(["security", "find-generic-password", "-D", "AirPort network password", "-a", ssid,
                       "-w", "/Library/Keychains/System.keychain"])
    return {"ssid": ssid, "password": password, "auth": "wpa-psk", "hidden": True}


def connected_name(os_name):
    """The Wi-Fi network this computer is on, by name only, or None. Reading the
    name needs no administrator rights; the password is read later, by the
    elevated step. Any failure is None: this only informs the review page."""
    try:
        if os_name == "Windows":
            return windows(name_only=True) or None
        if os_name == "Linux" and shutil.which("nmcli"):
            for line in output(["nmcli", "--terse", "--escape", "no", "--fields", "ACTIVE,SSID", "device", "wifi"]).splitlines():
                if line.startswith("yes:") and line[4:]:
                    return line[4:]
        if os_name == "Darwin" and shutil.which("networksetup"):
            ports = output(["networksetup", "-listallhardwareports"])
            match = re.search(r"Hardware Port: (?:Wi-Fi|AirPort)\nDevice: ([A-Za-z0-9]+)", ports)
            network = output(["networksetup", "-getairportnetwork", match[1]]) if match else ""
            return network.split(": ", 1)[1] if ": " in network else None
    except (WifiError, OSError, AttributeError, ValueError):
        return None
    return None


def capture(os_name):
    return {"Linux": linux, "Windows": windows, "Darwin": darwin}.get(os_name, lambda: None)()
