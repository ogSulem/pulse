import React from 'react';
import { createRoot } from 'react-dom/client';
// Шрифты лежат в сборке, а не тянутся с fonts.googleapis.com.
// Причина не в скорости: на мобильном интернете в России Google Fonts часто
// недоступен, и синхронный <link> в index.html держал первую отрисовку до
// тайм-аута — «с телефона не открывается». Здесь их отдаёт тот же сервер
// (assets immutable), браузер берёт только нужные наборы по unicode-range.
import '@fontsource-variable/manrope';
import '@fontsource-variable/jetbrains-mono';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
