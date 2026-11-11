/**
 * Demo data. Everything here is fictional. Safe to run more than once.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

// Demo logins for reviewers. Also listed in the README.
import { DEMO_PASSWORD } from "../src/lib/demo";
const BROKER_EMAIL = "broker@demo.test";
const POLICYHOLDER_EMAIL = "owner@acme-bakery.test";

async function main() {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  await db.user.upsert({
    where: { email: BROKER_EMAIL },
    update: { passwordHash },
    create: {
      email: BROKER_EMAIL,
      name: "Bailey Broker",
      role: "BROKER",
      passwordHash,
    },
  });

  const existing = await db.user.findUnique({ where: { email: POLICYHOLDER_EMAIL } });
  if (!existing) {
    const customer = await db.customer.create({
      data: {
        businessName: "Acme Bakery LLC",
        contactName: "Olive Owner",
        email: POLICYHOLDER_EMAIL,
        addressLine1: "100 Flour Street",
        city: "Springfield",
        state: "IL",
        postalCode: "62701",
      },
    });
    await db.user.create({
      data: {
        email: POLICYHOLDER_EMAIL,
        name: "Olive Owner",
        role: "POLICYHOLDER",
        passwordHash,
        customerId: customer.id,
      },
    });
  } else {
    await db.user.update({ where: { email: POLICYHOLDER_EMAIL }, data: { passwordHash } });
  }

  console.log("Seeded demo users:", BROKER_EMAIL, "and", POLICYHOLDER_EMAIL);
}

main().finally(() => db.$disconnect());
