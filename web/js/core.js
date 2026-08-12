// Долгоживущие объекты приложения: транспорт, WebRTC-сеть, голос, настройки.
//
// Они создаются один раз и живут, пока открыта страница, — комната приходит и
// уходит, а сокет, мост к оболочке и сохранённые настройки остаются. Собраны в
// одном месте, чтобы модуль интерфейса брал нужное импортом, а не получал
// десятью аргументами через цепочку init-функций.

import { Net } from './net.js';
import { Mesh } from './mesh.js';
import { Swarm } from './swarm.js';
import { Voice } from './voice.js';
import { Settings } from './settings.js';
import { Pointers } from './pointers.js';
import { Hotkeys } from './hotkeys.js';
import { RemoteControl } from './control.js';
import { native } from './native.js';
import { $ } from './ui.js';

export const settings = new Settings();
export const net = new Net();
export const mesh = new Mesh(net);
export const swarm = new Swarm(mesh);
export const voice = new Voice(mesh, settings);
export const hotkeys = new Hotkeys(settings);
export const control = new RemoteControl(mesh, native);
export const pointers = new Pointers(mesh, $('#stage'));

export { native };

/**
 * Адрес сервера — это всегда origin страницы: в приложении окно тоже грузится
 * прямо с сервера, иначе браузерный движок не даёт ни микрофон, ни захват экрана.
 */
export function serverBase() {
  return location.origin;
}
