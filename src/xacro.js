import { XacroParser } from 'xacro-parser';

const PARAM_SEGMENT_RE = /^[A-Za-z_$][\w$]*$/;

function formatParamValue(value) {
  if (Array.isArray(value)) return value.map((item) => formatParamValue(item)).join(' ');
  return String(value ?? '');
}

function escapeXmlAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function collectParamProperties(value, prefix = '', out = []) {
  if (Array.isArray(value)) {
    if (prefix) out.push([prefix, formatParamValue(value)]);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (!PARAM_SEGMENT_RE.test(key)) continue;
      collectParamProperties(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  if (prefix) out.push([prefix, formatParamValue(value)]);
  return out;
}

function injectParamProperties(xacroText, params = {}, sourceLabel = 'asm.xacro') {
  const properties = collectParamProperties(params);
  if (!properties.length) return xacroText;

  const rootMatch = /<robot\b[^>]*>/i.exec(xacroText);
  if (!rootMatch) throw new Error(`${sourceLabel} must contain a <robot> root element`);

  let rootTag = rootMatch[0];
  if (!/\sxmlns:xacro\s*=/.test(rootTag)) {
    rootTag = rootTag.replace(/>$/, ' xmlns:xacro="http://www.ros.org/wiki/xacro">');
  }

  const propertyText = properties
    .map(([name, value]) => `  <xacro:property name="${escapeXmlAttr(name)}" value="${escapeXmlAttr(value)}"/>`)
    .join('\n');
  return `${xacroText.slice(0, rootMatch.index)}${rootTag}\n${propertyText}${xacroText.slice(rootMatch.index + rootMatch[0].length)}`;
}

function serializeXmlDocument(document) {
  return new XMLSerializer().serializeToString(document);
}

function makeWorkingPath(xacroUrl) {
  const text = String(xacroUrl || '');
  const slash = text.lastIndexOf('/');
  return slash >= 0 ? text.slice(0, slash + 1) : '';
}

export async function expandXacro(text, params = {}, sourceLabel = 'asm.xacro', options = {}) {
  try {
    const parser = new XacroParser();
    parser.workingPath = options.workingPath || '';
    parser.getFileContents = options.getFileContents || ((includePath) => {
      throw new Error(`xacro include is not configured: ${includePath}`);
    });
    const document = await parser.parse(injectParamProperties(String(text || ''), params, sourceLabel));
    return serializeXmlDocument(document);
  } catch (e) {
    throw new Error(`${sourceLabel} xacro expansion failed: ${e.message || String(e)}`);
  }
}

export async function loadXacroDocument(xacroUrl, paramsUrl) {
  const xacroResp = await fetch(xacroUrl);
  if (!xacroResp.ok) throw new Error(`fetch ${xacroUrl} failed: ${xacroResp.status}`);
  const xacroText = await xacroResp.text();

  let params = {};
  if (paramsUrl) {
    const paramsResp = await fetch(paramsUrl);
    if (!paramsResp.ok) throw new Error(`fetch ${paramsUrl} failed: ${paramsResp.status}`);
    params = await paramsResp.json();
  }

  const workingPath = makeWorkingPath(xacroUrl);
  return expandXacro(xacroText, params, xacroUrl, {
    workingPath,
    getFileContents: async (includePath) => {
      const includeResp = await fetch(includePath);
      if (!includeResp.ok) throw new Error(`fetch ${includePath} failed: ${includeResp.status}`);
      return includeResp.text();
    }
  });
}
