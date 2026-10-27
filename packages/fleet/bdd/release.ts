export const FLEET_URL = 'https://fleet.example.com';
export const RELEASE_URL =
  'https://github.com/crvouga/fleet/releases/tag/fleet-installer';
export const DOWNLOAD_URL =
  'https://github.com/crvouga/fleet/releases/download/fleet-installer/';

export interface Asset {
  name: string;
  size: number;
  digest: string;
}

export async function publishedAssets(): Promise<Map<string, Asset>> {
  const response = await fetch(
    'https://api.github.com/repos/crvouga/fleet/releases/tags/fleet-installer',
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'fleet-bdd',
      },
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (response.status !== 200)
    throw new Error(`GitHub release API returned HTTP ${response.status}`);
  const release = (await response.json()) as {
    draft: boolean;
    tag_name: string;
    assets: Asset[];
  };
  if (release.draft || release.tag_name !== 'fleet-installer')
    throw new Error('The installer release is not published');
  return new Map(release.assets.map((asset) => [asset.name, asset]));
}
