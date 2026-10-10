import { startHttp } from './http.js';
import { startStdio } from './stdio.js';

const mode = process.argv[2];

if (mode === 'stdio') {
	await startStdio();
} else if (mode === 'http') {
	await startHttp();
} else {
	console.error('Usage: open-archiver-mcp <stdio|http>');
	process.exit(2);
}
