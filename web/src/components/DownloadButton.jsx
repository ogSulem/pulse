// Кнопка скачивания: один обработчик ошибок на все выгрузки.
//
// Раньше это были обычные <a href="/api/export/…?token=…">. Токен в адресе
// оседал в истории браузера и в логах сервера, а если сессия истекла, браузер
// просто показывал страницу с JSON-ошибкой вместо файла — и на телефоне это
// выглядело как «кнопка не работает». Здесь запрос идёт с заголовком, а любая
// проблема показывается человеческим текстом.
import { useState } from 'react';
import Icon from './Icons.jsx';
import { useToast } from './ui.jsx';

export default function DownloadButton({ action, label, icon = 'download', className = 'btn btn-sm btn-block', busyLabel = 'Готовим файл…' }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await action();
          if (res && !res.bytes) toast.push({ tone: 'warn', title: 'Файл пустой', text: 'Данных для выгрузки пока нет' });
        } catch (err) {
          toast.push({ tone: 'error', title: 'Не скачалось', text: err.message });
        } finally {
          setBusy(false);
        }
      }}
    >
      <Icon name={icon} size={13} />{busy ? busyLabel : label}
    </button>
  );
}
