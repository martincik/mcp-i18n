
export default {
    greeting: 'Hello, {{name}}!',
    farewell: 'Goodbye!',
    level: 1,
    active: true,
    nested: {
        message: "Nested Message",
        deeper: {
            value: 123
        },
        emptyObj: {}
    },
    items: [
        "Item 1",
        { id: 1, text: "Item Object" },
        'Template {{value}}',
        null,
        ["Sub", "Array"],
        undefined,
        void 0
    ],
    emptyArray: []
};
