import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { groupMembers } from '../db/schema.js';

export async function getUserGroupIds(userId: string): Promise<string[]> {
  const rows = await db.select({ groupId: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.userId, userId));
  return rows.map((r) => r.groupId);
}
