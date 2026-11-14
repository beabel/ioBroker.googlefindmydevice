'use strict';

// Object definitions for one tracker. Pure data, no adapter-core dependency,
// so the object tree can be unit-tested without a running ioBroker.

// Full 11-language common.name translations for the states created per
// tracker - the ioBroker repository checker's object structure check
// (W1001) expects every i18n name object to carry all of
// en/de/ru/pt/nl/fr/it/es/pl/uk/zh-cn, not just en/de.
const I18N = {
    deviceName: {
        en: 'Device name',
        de: 'Geraetename',
        ru: 'Имя устройства',
        pt: 'Nome do dispositivo',
        nl: 'Apparaatnaam',
        fr: "Nom de l'appareil",
        it: 'Nome del dispositivo',
        es: 'Nombre del dispositivo',
        pl: 'Nazwa urządzenia',
        uk: 'Назва пристрою',
        'zh-cn': '设备名称',
    },
    manufacturer: {
        en: 'Manufacturer',
        de: 'Hersteller',
        ru: 'Производитель',
        pt: 'Fabricante',
        nl: 'Fabrikant',
        fr: 'Fabricant',
        it: 'Produttore',
        es: 'Fabricante',
        pl: 'Producent',
        uk: 'Виробник',
        'zh-cn': '制造商',
    },
    model: {
        en: 'Model',
        de: 'Modell',
        ru: 'Модель',
        pt: 'Modelo',
        nl: 'Model',
        fr: 'Modèle',
        it: 'Modello',
        es: 'Modelo',
        pl: 'Model',
        uk: 'Модель',
        'zh-cn': '型号',
    },
    fastPairModelId: {
        en: 'Fast Pair model ID',
        de: 'Fast-Pair-Modell-ID',
        ru: 'ID модели Fast Pair',
        pt: 'ID do modelo Fast Pair',
        nl: 'Fast Pair-model-ID',
        fr: 'ID de modèle Fast Pair',
        it: 'ID modello Fast Pair',
        es: 'ID de modelo Fast Pair',
        pl: 'ID modelu Fast Pair',
        uk: 'ID моделі Fast Pair',
        'zh-cn': 'Fast Pair 型号 ID',
    },
    deviceType: {
        en: 'Device type',
        de: 'Geraetetyp',
        ru: 'Тип устройства',
        pt: 'Tipo de dispositivo',
        nl: 'Apparaattype',
        fr: "Type d'appareil",
        it: 'Tipo di dispositivo',
        es: 'Tipo de dispositivo',
        pl: 'Typ urządzenia',
        uk: 'Тип пристрою',
        'zh-cn': '设备类型',
    },
    pairDate: {
        en: 'Paired since',
        de: 'Gekoppelt seit',
        ru: 'Сопряжено с',
        pt: 'Emparelhado desde',
        nl: 'Gekoppeld sinds',
        fr: 'Associé depuis',
        it: 'Associato dal',
        es: 'Emparejado desde',
        pl: 'Sparowano od',
        uk: 'Спарено з',
        'zh-cn': '配对时间',
    },
    sharedWithCount: {
        en: 'Shared with (people)',
        de: 'Geteilt mit (Personen)',
        ru: 'Общий доступ (люди)',
        pt: 'Compartilhado com (pessoas)',
        nl: 'Gedeeld met (personen)',
        fr: 'Partagé avec (personnes)',
        it: 'Condiviso con (persone)',
        es: 'Compartido con (personas)',
        pl: 'Udostępniono (osoby)',
        uk: 'Спільний доступ (люди)',
        'zh-cn': '共享给(人数)',
    },
    latitude: {
        en: 'Latitude',
        de: 'Breitengrad',
        ru: 'Широта',
        pt: 'Latitude',
        nl: 'Breedtegraad',
        fr: 'Latitude',
        it: 'Latitudine',
        es: 'Latitud',
        pl: 'Szerokość geograficzna',
        uk: 'Широта',
        'zh-cn': '纬度',
    },
    longitude: {
        en: 'Longitude',
        de: 'Längengrad',
        ru: 'Долгота',
        pt: 'Longitude',
        nl: 'Lengtegraad',
        fr: 'Longitude',
        it: 'Longitudine',
        es: 'Longitud',
        pl: 'Długość geograficzna',
        uk: 'Довгота',
        'zh-cn': '经度',
    },
    altitude: {
        en: 'Altitude',
        de: 'Höhe',
        ru: 'Высота',
        pt: 'Altitude',
        nl: 'Hoogte',
        fr: 'Altitude',
        it: 'Altitudine',
        es: 'Altitud',
        pl: 'Wysokość',
        uk: 'Висота',
        'zh-cn': '海拔',
    },
    lastSeen: {
        en: 'Last seen',
        de: 'Zuletzt gesehen',
        ru: 'Последнее обнаружение',
        pt: 'Visto pela última vez',
        nl: 'Laatst gezien',
        fr: 'Vu pour la dernière fois',
        it: 'Ultimo avvistamento',
        es: 'Visto por última vez',
        pl: 'Ostatnio widziany',
        uk: 'Востаннє виявлено',
        'zh-cn': '最后出现时间',
    },
    semanticLocation: {
        en: 'Semantic location (e.g. "Home")',
        de: 'Semantischer Standort (z.B. "Zuhause")',
        ru: 'Смысловое местоположение (например, "Дом")',
        pt: 'Localização semântica (ex.: "Casa")',
        nl: 'Semantische locatie (bijv. "Thuis")',
        fr: 'Emplacement sémantique (p. ex. « Domicile »)',
        it: 'Posizione semantica (es. "Casa")',
        es: 'Ubicación semántica (p. ej., "Casa")',
        pl: 'Lokalizacja semantyczna (np. "Dom")',
        uk: 'Смислове місцезнаходження (напр., "Дім")',
        'zh-cn': '语义位置(例如"家")',
    },
    accuracy: {
        en: 'Accuracy',
        de: 'Genauigkeit',
        ru: 'Точность',
        pt: 'Precisão',
        nl: 'Nauwkeurigheid',
        fr: 'Précision',
        it: 'Precisione',
        es: 'Precisión',
        pl: 'Dokładność',
        uk: 'Точність',
        'zh-cn': '精度',
    },
    isOwnReport: {
        en: 'Reported by one of your own devices (not relayed by another device)',
        de: 'Von einem eigenen Gerät gemeldet (nicht über ein fremdes Gerät weitergeleitet)',
        ru: 'Сообщено одним из ваших устройств (а не переслано чужим устройством)',
        pt: 'Reportado por um dos seus dispositivos (não retransmitido por outro dispositivo)',
        nl: 'Gemeld door een van je eigen apparaten (niet doorgegeven door een ander apparaat)',
        fr: "Signalé par l'un de vos appareils (et non relayé par un autre appareil)",
        it: 'Segnalato da uno dei tuoi dispositivi (non inoltrato da un altro dispositivo)',
        es: 'Informado por uno de tus dispositivos (no retransmitido por otro dispositivo)',
        pl: 'Zgłoszone przez jedno z Twoich urządzeń (nie przekazane przez inne urządzenie)',
        uk: 'Повідомлено одним із ваших пристроїв (а не передано іншим пристроєм)',
        'zh-cn': '由您自己的设备报告(而非由其他设备转发)',
    },
    locateNow: {
        en: 'Locate now',
        de: 'Jetzt orten',
        ru: 'Определить местоположение сейчас',
        pt: 'Localizar agora',
        nl: 'Nu lokaliseren',
        fr: 'Localiser maintenant',
        it: 'Localizza ora',
        es: 'Localizar ahora',
        pl: 'Zlokalizuj teraz',
        uk: 'Визначити місцеперебування зараз',
        'zh-cn': '立即定位',
    },
    playSound: {
        en: 'Play sound',
        de: 'Ton abspielen',
        ru: 'Воспроизвести звук',
        pt: 'Tocar som',
        nl: 'Geluid afspelen',
        fr: 'Jouer un son',
        it: 'Riproduci suono',
        es: 'Reproducir sonido',
        pl: 'Odtwórz dźwięk',
        uk: 'Відтворити звук',
        'zh-cn': '播放声音',
    },
    stopSound: {
        en: 'Stop sound',
        de: 'Ton stoppen',
        ru: 'Остановить звук',
        pt: 'Parar som',
        nl: 'Geluid stoppen',
        fr: 'Arrêter le son',
        it: 'Interrompi suono',
        es: 'Detener sonido',
        pl: 'Zatrzymaj dźwięk',
        uk: 'Зупинити звук',
        'zh-cn': '停止声音',
    },
    tracking: {
        en: 'Automatic location requests',
        de: 'Automatische Standortabfrage',
        ru: 'Автоматические запросы местоположения',
        pt: 'Pedidos automáticos de localização',
        nl: 'Automatische locatieverzoeken',
        fr: 'Demandes de position automatiques',
        it: 'Richieste di posizione automatiche',
        es: 'Solicitudes de ubicación automáticas',
        pl: 'Automatyczne zapytania o lokalizację',
        uk: 'Автоматичні запити місцеперебування',
        'zh-cn': '自动位置请求',
    },
    mapsLink: {
        en: 'Google Maps link',
        de: 'Google-Maps-Link',
        ru: 'Ссылка на Google Maps',
        pt: 'Link do Google Maps',
        nl: 'Google Maps-link',
        fr: 'Lien Google Maps',
        it: 'Link di Google Maps',
        es: 'Enlace de Google Maps',
        pl: 'Link do Google Maps',
        uk: 'Посилання на Google Maps',
        'zh-cn': 'Google 地图链接',
    },
    receivedPushIds: {
        en: 'IDs of push messages already received (internal)',
        de: 'IDs bereits empfangener Push-Nachrichten (intern)',
        ru: 'ID уже полученных push-сообщений (служебное)',
        pt: 'IDs das mensagens push já recebidas (interno)',
        nl: "ID's van reeds ontvangen pushberichten (intern)",
        fr: 'ID des messages push déjà reçus (interne)',
        it: 'ID dei messaggi push già ricevuti (interno)',
        es: 'ID de los mensajes push ya recibidos (interno)',
        pl: 'Identyfikatory już odebranych wiadomości push (wewnętrzne)',
        uk: 'ID вже отриманих push-повідомлень (службове)',
        'zh-cn': '已收到的推送消息 ID(内部使用)',
    },
};

// One entry per state below the tracker's device object. Roles follow
// ioBroker's state-role list - the most specific one that fits.
const DEVICE_STATES = [
    { key: 'name', name: I18N.deviceName, type: 'string', role: 'info.name' },
    { key: 'manufacturer', name: I18N.manufacturer, type: 'string', role: 'text' },
    { key: 'model', name: I18N.model, type: 'string', role: 'info.model' },
    { key: 'fastPairModelId', name: I18N.fastPairModelId, type: 'string', role: 'text' },
    { key: 'deviceType', name: I18N.deviceType, type: 'string', role: 'text' },
    { key: 'pairDate', name: I18N.pairDate, type: 'number', role: 'value.time' },
    { key: 'sharedWithCount', name: I18N.sharedWithCount, type: 'number', role: 'value' },
    { key: 'latitude', name: I18N.latitude, type: 'number', role: 'value.gps.latitude' },
    { key: 'longitude', name: I18N.longitude, type: 'number', role: 'value.gps.longitude' },
    { key: 'altitude', name: I18N.altitude, type: 'number', role: 'value.gps.elevation', unit: 'm' },
    { key: 'lastSeen', name: I18N.lastSeen, type: 'number', role: 'value.time' },
    { key: 'semanticLocation', name: I18N.semanticLocation, type: 'string', role: 'text' },
    { key: 'accuracy', name: I18N.accuracy, type: 'number', role: 'value.gps.accuracy', unit: 'm' },
    { key: 'isOwnReport', name: I18N.isOwnReport, type: 'boolean', role: 'indicator' },
    { key: 'mapsLink', name: I18N.mapsLink, type: 'string', role: 'text.url' },
    // A switch the user or a script can set: pauses the automatic location requests of this tracker.
    { key: 'tracking', name: I18N.tracking, type: 'boolean', role: 'switch.enable', writable: true, def: true },
    // Buttons: writable, not readable, and answered by onStateChange in main.js.
    { key: 'locateNow', name: I18N.locateNow, type: 'boolean', role: 'button', button: true },
    { key: 'playSound', name: I18N.playSound, type: 'boolean', role: 'button.play', button: true },
    { key: 'stopSound', name: I18N.stopSound, type: 'boolean', role: 'button.stop', button: true },
];

/**
 * Builds the object definitions for one tracker: the tracker itself as a
 * `device` object directly below the adapter instance, followed by all its
 * states. The first entry has an empty `suffix` (the device object itself).
 *
 * @param {string} name the tracker's own display name
 * @returns {Array<{suffix: string, obj: object}>} definitions, device first
 */
function buildDeviceObjects(name) {
    // The device's name is the tracker's own (arbitrary, user-chosen) name,
    // not translatable adapter text - a plain string, not an i18n object.
    const definitions = [];
    definitions.push({ suffix: '', obj: { type: 'device', common: { name }, native: {} } });

    for (const state of DEVICE_STATES) {
        const common = {
            name: state.name,
            type: state.type,
            role: state.role,
            read: !state.button,
            write: !!(state.button || state.writable),
        };
        if (state.def !== undefined) {
            common.def = state.def;
        }
        if (state.unit) {
            common.unit = state.unit;
        }
        definitions.push({ suffix: state.key, obj: { type: 'state', common, native: {} } });
    }

    return definitions;
}

// Internal state that remembers which push messages were already received, so
// Google does not deliver them again at the next login.
const PUSH_IDS_STATE_ID = 'info.receivedPushIds';
/**
 * Builds the definition of the internal state that holds the received message ids.
 *
 * @returns {object} the state object
 */
function buildPushIdsObject() {
    return {
        type: 'state',
        common: { name: I18N.receivedPushIds, type: 'string', role: 'json', read: true, write: false, def: '[]' },
        native: {},
    };
}

module.exports = {
    PUSH_IDS_STATE_ID,
    buildPushIdsObject,
    I18N,
    DEVICE_STATES,
    buildDeviceObjects,
};
