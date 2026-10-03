export const initialMessage = "比较乳液，1件，100到300ml正装，总预算200港币含运费，配送香港，希望保湿。"
export const volume = (lo, hi) => [{ field: "attributes.volumeMl", op: "gte", value: lo }, { field: "attributes.volumeMl", op: "lte", value: hi }]
export const moisture = { field: "text.searchable", op: "containsAny", value: ["保湿"] }
export const pack = { field: "attributes.packageType", op: "eq", value: "regular" }
export const edit = (field, replace) => ({ field, replace })
export const wire = (requirementDraft = {}, evidence = {}, intentEvidence = null, extra = {}) => JSON.stringify({ intent: "compare", intentEvidence, requirementDraft, evidence, missingFields: [], clarificationQuestions: [], ...extra })
export const initialWire = () => wire({ category: "乳液", currency: "HKD", quantity: 1, destination: "香港", budget: { amountHKD: "200", scope: "delivered" }, hardConstraints: [edit("attributes.volumeMl", volume(100, 300)), edit("attributes.packageType", [pack])], preferences: [edit("text.searchable", [{ field: "text.searchable", weight: 1, source: "explicit", conditions: [moisture] }])] }, { category: "乳液", currency: "港币", quantity: "1件", destination: "香港", "budget.amountHKD": "200港币", "budget.scope": "含运费", hardConstraints: "100到300ml正装", preferences: "希望保湿" }, "比较")
