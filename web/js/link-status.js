// Состояние `RTCPeerConnection.connectionState` — словами и с оценкой. Один
// источник для диагностики (`settings-panel.js`) и для списка участников
// (`peers.js`): раньше словарь жил только в диагностике, и появись то же самое
// в списке — оно завело бы свой перевод состояний WebRTC на русский, который
// неизбежно разъехался бы с диагностикой первой же правкой одного файла без
// другого.

export const OK = 'ok';
export const WARN = 'warn';
export const BAD = 'bad';

export const LINKS = {
  new: [WARN, 'соединяемся'],
  connecting: [WARN, 'соединяемся'],
  connected: [OK, ''],
  disconnected: [WARN, 'связь пропала, восстанавливаем'],
  failed: [BAD, 'связи нет'],
  closed: [BAD, 'соединение закрыто'],
};
