function mapRow(row) {
  return {
    id: String(row.id),
    direction: row.direction,
    entryTime: row.entry_time,
    entryPrice: row.entry_price,
    exitPrice: row.exit_price,
    pl: row.profit_loss,
    notes: row.notes,
    confluences: Array.isArray(row.confluences) ? row.confluences : [],
    screenshotCount: Number(row.screenshot_count),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export function createPostgresJournalRepository(client) {
  return {
    async list(ownerId) {
      const result = await client.query(`
        SELECT id, direction, entry_time, entry_price, exit_price, profit_loss,
               notes, confluences, screenshot_count, created_at
        FROM journal_entries
        WHERE owner_id = $1
        ORDER BY created_at DESC, id DESC
      `, [String(ownerId)]);
      return result.rows.map(mapRow);
    },
    async find(ownerId, id) {
      const result = await client.query(`
        SELECT id, direction, entry_time, entry_price, exit_price, profit_loss,
               notes, confluences, screenshot_count, created_at
        FROM journal_entries
        WHERE owner_id = $1 AND id = $2
        LIMIT 1
      `, [String(ownerId), String(id)]);
      return result.rows[0] ? mapRow(result.rows[0]) : undefined;
    },
    async create(ownerId, entry) {
      await client.query(`
        INSERT INTO journal_entries (
          id, owner_id, direction, entry_time, entry_price, exit_price,
          profit_loss, notes, confluences, screenshot_count, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
      `, [
        entry.id, String(ownerId), entry.direction, entry.entryTime, entry.entryPrice,
        entry.exitPrice, entry.pl, entry.notes, JSON.stringify(entry.confluences), entry.screenshotCount,
        entry.createdAt,
      ]);
      return entry;
    },
  };
}
