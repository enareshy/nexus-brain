import { findUserBySubject, type DirectoryUser, type PoolLike } from "@brain/db";

export type { DirectoryUser };

export interface UserDirectory {
  findBySubject(tenantId: string, subject: string): Promise<DirectoryUser | null>;
}

export function createDbUserDirectory(pool: PoolLike): UserDirectory {
  return {
    findBySubject: (tenantId, subject) => findUserBySubject(pool, tenantId, subject),
  };
}
