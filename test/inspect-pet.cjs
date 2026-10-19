/**
 * Measure the xiaowu pet's footprint so the balance badge can sit clear of it.
 *
 *   node test/inspect-pet.cjs
 *
 * The pet is fixed to the bottom-right corner; this reads its declared corner
 * offsets, scale variable and intrinsic SVG size out of its bundle so the badge
 * offset can be chosen from numbers rather than guessed.
 */
const fs = require("node:fs");

const bundle = "D:/dsh/dsh-home/plugin-src/dsh-plugin-xiaowu/lib/client.js";
const source = fs.readFileSync(bundle, "utf8");

const pick = (re) => {
	const found = source.match(re);
	return found === null ? "(none)" : [...new Set(found)].slice(0, 6).join(" | ");
};

console.log("root corner   : " + pick(/right:\d+px;bottom:\d+px/g));
console.log("scale var     : " + pick(/--xw-s:\s*[-\d.]+/g));
console.log("width calc    : " + pick(/width:calc\([^)]*\)/g));
console.log("height calc   : " + pick(/height:calc\([^)]*\)/g));
console.log("svg width     : " + pick(/width="\d+"/g));
console.log("svg height    : " + pick(/height="\d+"/g));
console.log("viewBox       : " + pick(/viewBox="[^"]+"/g));
console.log("z-index       : " + pick(/z-index:\d+/g));
