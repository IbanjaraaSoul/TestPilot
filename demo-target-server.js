import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 3456;

app.use(express.static(path.join(__dirname, "demo-target")));
app.listen(PORT, () => console.log(`Demo target app at http://localhost:${PORT}`));
