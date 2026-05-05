const PARAM_PATH_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

function formatParamValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => formatParamValue(item)).join(' ');
  return String(value ?? '');
}

function escapeXmlAttr(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getParamPath(params: Record<string, unknown>, key: string, sourceLabel: string): unknown {
  if (!PARAM_PATH_RE.test(key)) {
    throw new Error(`${sourceLabel} has unsupported parameter expression: \${${key}}`);
  }
  let current: unknown = params;
  for (const segment of key.split('.')) {
    if (!current || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`${sourceLabel} references missing params.json value: \${${key}}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function interpolateMjcfParams(
  text: string,
  params: Record<string, unknown> = {},
  sourceLabel = 'asm.xml'
): string {
  return String(text || '').replace(/<!--[\s\S]*?-->|(\$\{([^}]+)\})/g, (match, expr, rawKey) => {
    if (!expr) return match;
    const key = String(rawKey || '').trim();
    return escapeXmlAttr(formatParamValue(getParamPath(params, key, sourceLabel)));
  });
}

export async function loadMjcfDocument(mjcfUrl: string, paramsUrl?: string): Promise<string> {
  const mjcfResp = await fetch(mjcfUrl);
  if (!mjcfResp.ok) throw new Error(`fetch ${mjcfUrl} failed: ${mjcfResp.status}`);
  const mjcfText = await mjcfResp.text();

  let params: Record<string, unknown> = {};
  if (paramsUrl) {
    const paramsResp = await fetch(paramsUrl);
    if (!paramsResp.ok) throw new Error(`fetch ${paramsUrl} failed: ${paramsResp.status}`);
    params = await paramsResp.json();
  }

  return interpolateMjcfParams(mjcfText, params, mjcfUrl);
}
