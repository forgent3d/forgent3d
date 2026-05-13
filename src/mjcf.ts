const PARAM_PATH_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const PARAM_TOKEN_RE = /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\b/g;
const NUMERIC_EXPR_RE = /^[\d+\-*/().\sA-Za-z_$]+$/;

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

function evaluateParamExpression(params: Record<string, unknown>, expression: string, sourceLabel: string): unknown {
  const expr = String(expression || '').trim();
  if (PARAM_PATH_RE.test(expr)) return getParamPath(params, expr, sourceLabel);
  if (!NUMERIC_EXPR_RE.test(expr)) {
    throw new Error(`${sourceLabel} has unsupported parameter expression: \${${expr}}`);
  }
  const values: number[] = [];
  const jsExpr = expr.replace(PARAM_TOKEN_RE, (key) => {
    const value = getParamPath(params, key, sourceLabel);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${sourceLabel} expression requires numeric params.json value: \${${key}}`);
    }
    values.push(value);
    return `__v[${values.length - 1}]`;
  });
  if (!/^[\d+\-*/().\s_[\]v]+$/.test(jsExpr)) {
    throw new Error(`${sourceLabel} has unsupported parameter expression: \${${expr}}`);
  }
  const result = Function('__v', `"use strict"; return (${jsExpr});`)(values);
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new Error(`${sourceLabel} parameter expression did not produce a finite number: \${${expr}}`);
  }
  return result;
}

export function interpolateMjcfParams(
  text: string,
  params: Record<string, unknown> = {},
  sourceLabel = 'asm.xml'
): string {
  return String(text || '').replace(/<!--[\s\S]*?-->|(\$\{([^}]+)\})/g, (match, expr, rawKey) => {
    if (!expr) return match;
    const key = String(rawKey || '').trim();
    return escapeXmlAttr(formatParamValue(evaluateParamExpression(params, key, sourceLabel)));
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
