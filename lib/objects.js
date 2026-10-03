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
        en: 'Reported directly by the tracker (not via a stranger nearby)',
        de: 'Direkt vom Tracker gemeldet (nicht ueber ein fremdes Geraet in der Naehe)',
        ru: 'Сообщено напрямую трекером (не через постороннее устройство поблизости)',
        pt: 'Reportado diretamente pelo rastreador (não por meio de um dispositivo estranho por perto)',
        nl: 'Direct gemeld door de tracker (niet via een onbekend apparaat in de buurt)',
        fr: 'Signalé directement par le traceur (pas via un appareil étranger à proximité)',
        it: 'Segnalato direttamente dal tracker (non tramite un dispositivo sconosciuto nelle vicinanze)',
        es: 'Informado directamente por el rastreador (no a través de un dispositivo desconocido cercano)',
        pl: 'Zgłoszone bezpośrednio przez lokalizator (nie za pośrednictwem obcego urządzenia w pobliżu)',
        uk: 'Повідомлено безпосередньо трекером (не через сторонній пристрій поблизу)',
        'zh-cn': '由追踪器直接报告(而非通过附近的陌生设备)',
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
        const common = { name: state.name, type: state.type, role: state.role, read: true, write: false };
        if (state.unit) {
            common.unit = state.unit;
        }
        definitions.push({ suffix: state.key, obj: { type: 'state', common, native: {} } });
    }

    return definitions;
}

module.exports = { I18N, DEVICE_STATES, buildDeviceObjects };
