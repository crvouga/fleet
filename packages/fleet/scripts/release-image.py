#!/usr/bin/env python3
"""Split the offline ISO into release assets below GitHub's 2 GiB limit."""
import argparse
import hashlib
import json
from pathlib import Path
import decide

PART_SIZE = 1024 ** 3


def validate_image(source):
    """Exercise the installer's reader against the built ISO before publishing.

    Boot menus alone do not prove their referenced files can be found or read.
    Check every role, including Windows' marker and EFI loader requirements.
    """
    with open(source, 'rb') as image:
        files = decide._iso_index(image)
        readiness = json.loads(decide._iso_bytes(image, files, 'fleet-readiness.json'))
        for role in decide.ROLES:
            decide.iso_boot_material(source, role)
    if readiness.get('version') != 1 or not isinstance(readiness.get('roles'), dict):
        raise ValueError('installer image has no valid onboarding readiness metadata')
    return readiness


def package_image(source, directory, part_size=PART_SIZE):
    if not 0 < part_size < 2 * 1024 ** 3:
        raise ValueError("release parts must be smaller than 2 GiB")
    readiness = validate_image(source)
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    parts = []
    with open(source, "rb") as image:
        while True:
            block = image.read(min(part_size, 4 * 1024 ** 2))
            if not block:
                break
            name = f"fleet-installer.iso.part-{len(parts):03d}"
            size = 0
            part_digest = hashlib.sha256()
            with open(directory / name, "wb") as part:
                while block:
                    part.write(block)
                    digest.update(block)
                    part_digest.update(block)
                    size += len(block)
                    if size == part_size:
                        break
                    block = image.read(min(part_size - size, 4 * 1024 ** 2))
            parts.append({"name": name, "size": size, "sha256": part_digest.hexdigest()})
    if not parts:
        raise ValueError("refusing to publish an empty installer")
    manifest = {"version": 1, "size": sum(part["size"] for part in parts),
                "sha256": digest.hexdigest(), "parts": parts}
    (directory / "fleet-installer.iso.parts.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (directory / "fleet-installer.iso.sha256").write_text(digest.hexdigest() + "  fleet-installer.iso\n")
    readiness['imageSha256'] = digest.hexdigest()
    (directory / 'fleet-installer.readiness.json').write_text(json.dumps(readiness) + '\n')
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='validate boot material without creating release assets')
    parser.add_argument('source', type=Path)
    parser.add_argument('directory', type=Path, nargs='?')
    args = parser.parse_args()
    if args.check:
        validate_image(args.source)
    elif args.directory is None:
        parser.error('directory is required when packaging an image')
    else:
        package_image(args.source, args.directory)
