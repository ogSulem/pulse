// ─────────────────────────────────────────────────────────────────────────────
// Копирование текста, которое работает и на телефоне.
//
// `navigator.clipboard` существует только в «безопасном контексте»: https или
// localhost. Если панель открыли по http://IP:8080 (обычный случай локального
// стенда) или в старом WebView, объекта просто нет — и кнопка «Копировать»
// падала в catch. Теперь есть запасной путь через скрытое поле: он работает
// везде, где работает сам браузер.
// ─────────────────────────────────────────────────────────────────────────────

/** Копирует текст. true — скопировано, false — не вышло (покажем текст руками). */
export async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return false;

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* пробуем запасной путь ниже */ }

  try {
    const area = document.createElement('textarea');
    area.value = value;
    // Вне экрана, но не display:none — иначе iOS не даст выделить и скопировать
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, value.length);
    const done = document.execCommand('copy');
    document.body.removeChild(area);
    return done;
  } catch {
    return false;
  }
}
