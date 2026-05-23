// Prisma ESM config for projects with "type": "module"
export default {
  datasources: {
    db: {
      provider: 'postgresql',
      url: process.env.DATABASE_URL,
    },
  },
};
