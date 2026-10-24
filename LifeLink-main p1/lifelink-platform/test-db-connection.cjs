const { PrismaClient } = require("@prisma/client");

async function main() {
const prisma = new PrismaClient();

try {
await prisma.$connect();
await prisma.$queryRawUnsafe("SELECT 1");
console.log("SUCCESS: Database connection established.");
} catch (error) {
console.error("FAILED: Database connection could not be established.");
console.error("Error:", error.message);
process.exitCode = 1;
} finally {
await prisma.$disconnect();
}
}

main();
