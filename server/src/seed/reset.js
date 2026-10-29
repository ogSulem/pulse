// Пересоздание демо-данных: npm run seed
import { migrate } from '../core/db.js';
import { reseed } from './seed.js';

migrate();
await reseed();
console.log('✔ Демо-данные пересозданы');
process.exit(0);
