import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { db } from "./db";
import { readSession } from "./session";
import type { Role } from "@/generated/prisma/client";

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  customerId: string | null;
};

/** The signed-in user, or null. Cached for the duration of one request. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await readSession();
  if (!session) return null;
  const user = await db.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, name: true, role: true, customerId: true },
  });
  return user;
});

/** Use at the top of every page and server action. Redirects if not allowed. */
export async function requireUser(role?: Role): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (role && user.role !== role) redirect(homeFor(user.role));
  return user;
}

export function homeFor(role: Role) {
  return role === "BROKER" ? "/broker" : "/portal";
}
