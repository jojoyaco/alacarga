import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('HTML no contiene atributos en etiquetas de cierre que pierdan opciones del selector', () => {
  for (const [tag] of html.matchAll(/<\/[a-z][^>]*>/gi)) {
    assert.match(tag, /^<\/[a-z][a-z\d:-]*\s*>$/i, `Etiqueta de cierre inválida: ${tag}`);
  }
  const filter = html.match(/<select id="connector-filter"[^>]*>(.*?)<\/select>/s)[1];
  assert.deepEqual([...filter.matchAll(/<option value="([^"]+)"/g)].map(m => m[1]), ['ANY', 'TYPE2', 'CCS2', 'CHADEMO', 'SCHUKO']);
});

test('El acceso público solo ofrece EVsare, con correo o usuario libre', () => {
  const login = html.match(/<form id="login-form"[^>]*>(.*?)<\/form>/s)[1];
  assert.doesNotMatch(login, /pattern=/);
  assert.match(login, /name="username"[^>]*maxlength="254"/);
  assert.match(login, /name="password"[^>]*maxlength="1024"/);
  assert.doesNotMatch(login, /minlength="12"/);
  assert.equal(html.includes('register-form'), false);
  assert.doesNotMatch(html, /admin-login-(?:tab|panel|form)|action="\/api\/admin\/login"/);
  assert.match(html, /A la caaarga!! envía tus credenciales a IBILcloud.*Tu contraseña no se guarda.*token.*cifrado/);
});

test('La landing no muestra el área privada antes de verificar la sesión', () => {
  assert.match(html, /class="workspace" data-session-only hidden/);
  assert.match(html, /class="mobile-nav"[^>]*data-session-only hidden/);
  assert.match(html, /id="landing-login"[\s\S]*Tres pasos\. Menos vueltas\.[\s\S]*Encuentra tu ubicación/);
  assert.doesNotMatch(html, /source-notice|Tu cuenta EVsare\. Una cola comunitaria\./);
});
