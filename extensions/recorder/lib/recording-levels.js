(() => {
    function dbToFraction(db) {
        const clamped = Math.max(-60, Math.min(0, db));
        return (clamped + 60) / 60;
    }

    function dbToWidth(db) {
        return `${Math.round(dbToFraction(db) * 100)}%`;
    }

    globalThis.recorderLevels = { dbToFraction, dbToWidth };
})();
