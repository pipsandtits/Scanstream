import { defineConfig } from '@prisma/sdk';

export default defineConfig({
  datasources: {
    db: {
      provider: 'postgresql',
      url: process.env.DATABASE_URL,
    },
  },
});
