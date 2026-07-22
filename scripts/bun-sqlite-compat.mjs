import { Database } from "bun:sqlite";

// Berry uses the API subset shared by Node's DatabaseSync and Bun's Database:
// constructor(path), exec(), prepare().get/all/run(), and close().
export const DatabaseSync = Database;
