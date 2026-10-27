import initSqlJs from 'sql.js';
import { openDatabase, setSqlJs } from './sqljs';

/** vitest "sqljs" projesi: sunucu testleri tarayıcı demosunun veritabanıyla (sql.js) koşar; her test dosyası boş veritabanıyla başlar */
setSqlJs(await initSqlJs());
openDatabase();
