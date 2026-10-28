export const FLEET_URL = process.env['FLEET_BDD_URL'] ?? '';
export const RELEASE_URL = `${FLEET_URL}/installers/release`;
export const DOWNLOAD_URL = `${FLEET_URL}/installers/assets/`;

export interface Asset {
  name: string;
  size: number;
  digest: string;
}

export async function publishedAssets(): Promise<Map<string, Asset>> {
  const names = [
    'fleet-installer-windows-x64.exe',
    'fleet-installer-macos-arm64.zip',
    'fleet-installer-macos-x64.zip',
    'fleet-installer-linux-arm64.tar.gz',
    'fleet-installer-linux-x64.tar.gz',
  ];
  const assets = await Promise.all(
    names.map(async (name): Promise<Asset> => {
      const [head, checksum] = await Promise.all([
        fetch(DOWNLOAD_URL + name, {
          method: 'HEAD',
          signal: AbortSignal.timeout(30_000),
        }),
        fetch(DOWNLOAD_URL + name + '.sha256', {
          signal: AbortSignal.timeout(30_000),
        }),
      ]);
      if (!head.ok || !checksum.ok)
        throw new Error(`Fleet has not published ${name} with its checksum`);
      const sha = (await checksum.text()).trim().split(/\s+/)[0];
      if (!sha || !/^[a-f0-9]{64}$/i.test(sha))
        throw new Error('Invalid published installer checksum');
      return {
        name,
        size: Number(head.headers.get('content-length')),
        digest: `sha256:${sha.toLowerCase()}`,
      };
    })
  );
  return new Map(assets.map((asset) => [asset.name, asset]));
}
