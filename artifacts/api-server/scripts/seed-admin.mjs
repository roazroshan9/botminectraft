import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const ADMIN_USERNAME = "admin";
const ADMIN_EMAIL = "roazroshan@gmail.com";
const ADMIN_PASSWORD = "McBot@Admin2026!";

async function main() {
  console.log("🌱 Seeding admin user...");

  const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });

  if (existing) {
    console.log(`ℹ️  User with email "${ADMIN_EMAIL}" already exists (id=${existing.id}). Skipping creation.`);
    await prisma.$disconnect();
    return;
  }

  const password_hash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  const user = await prisma.user.create({
    data: {
      username: ADMIN_USERNAME,
      email: ADMIN_EMAIL,
      password_hash,
      tier: "admin",
      is_active: true,
    },
  });

  console.log(`✅ Admin user created!`);
  console.log(`   ID:       ${user.id}`);
  console.log(`   Username: ${user.username}`);
  console.log(`   Email:    ${user.email}`);
  console.log(`   Tier:     ${user.tier}`);
  console.log(`   Password: ${ADMIN_PASSWORD}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("❌ Seed failed:", e.message);
  process.exit(1);
});
