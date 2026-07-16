import { customType, sqliteTable, text } from "drizzle-orm/sqlite-core"

const varchar = customType<{ data: string }>({
  dataType() {
    return "varchar"
  },
})

function uuidv7() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const timestamp = BigInt(Date.now())

  for (let index = 5; index >= 0; index--) {
    bytes[index] = Number((timestamp >> BigInt((5 - index) * 8)) & 0xffn)
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  return [...bytes]
    .map((byte, index) => {
      const hex = byte.toString(16).padStart(2, "0")
      return [4, 6, 8, 10].includes(index) ? `-${hex}` : hex
    })
    .join("")
}

export const user = sqliteTable("user", {
  id: text("id").primaryKey().$defaultFn(uuidv7),
  email: varchar("email").notNull(),
  name: varchar("name"),
})
