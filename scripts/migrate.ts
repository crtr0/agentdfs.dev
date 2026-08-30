import "dotenv/config";
import { runMigrations } from "./migrations";

await runMigrations();
