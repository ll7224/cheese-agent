export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

export function highlightCode(code, lang) {
  if (!/^(js|javascript|ts|typescript|jsx|tsx|py|python|sh|bash|shell|json)$/i.test(lang || '')) {
    return escapeHtml(code);
  }
  // Match source once: never run a token rule over generated tags or attributes.
  const tokens = /(?<comment>\/\/[^\n]*|#[^\n]*)|(?<string>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(?<number>\b\d+(?:\.\d+)?\b)|(?<keyword>\b(?:const|let|var|function|return|import|export|from|default|class|extends|if|else|switch|case|break|try|catch|finally|throw|new|typeof|instanceof|async|await|def|for|in|of|while|do|continue|type|interface|enum|public|private|protected|static|readonly|true|false|null|undefined|None|self)\b)|(?<function>\b[a-zA-Z_$][a-zA-Z0-9_$]*(?=\s*\())/g;
  let html = '';
  let offset = 0;
  for (const match of String(code).matchAll(tokens)) {
    html += escapeHtml(code.slice(offset, match.index));
    const kind = Object.keys(match.groups).find(key => match.groups[key] !== undefined);
    html += `<span class="hl-${kind}">${escapeHtml(match[0])}</span>`;
    offset = match.index + match[0].length;
  }
  return html + escapeHtml(code.slice(offset));
}
