
/* ---- cf-tg-checkin patch: no-eval field codecs (workerd 禁止 new Function) ---- */
function __cfReadInline(reader, context, fields, index) {
    const field = fields[index];
    if (field.isFlagsIndicator) return reader.readInt();
    const type = field.type;
    if (!field.isVector && type) {
        if (type === "int") return reader.readInt();
        if (type === "long") return reader.readLong();
        if (type === "int128") return reader.readLargeInt(128);
        if (type === "int256") return reader.readLargeInt(256);
        if (type === "double") return reader.readDouble();
        if (type === "string") return reader.tgReadString();
        if (type === "Bool") return reader.tgReadBool();
        if (type === "bytes") return reader.tgReadBytes();
        if (type === "date") return reader.tgReadDate();
    }
    if (!field.isVector && !field.bare) return reader.tgReadObject();
    return readField(context, reader, field);
}
exports.compileFieldsReader = function compileFieldsReader(context, fields) {
    const names = fields.map((field) => field.name);
    const flagFields = fields.map((field) => (field.isFlag ? fields[field.flagField].name : null));
    return function read(reader, target) {
        for (let i = 0; i < fields.length; i++) {
            const field = fields[i];
            if (field.isFlag) {
                const isSet = (target[flagFields[i]] & (1 << field.flagBit)) !== 0;
                target[names[i]] = field.type === "true" ? isSet : isSet ? __cfReadInline(reader, context, fields, i) : null;
                continue;
            }
            target[names[i]] = __cfReadInline(reader, context, fields, i);
        }
    };
};
exports.compileFieldsCopier = function compileFieldsCopier(fields) {
    const names = fields.map((field) => field.name);
    return function copy(target, source) {
        for (let i = 0; i < names.length; i++) target[names[i]] = source[names[i]];
    };
};
/* ---- end patch ---- */
