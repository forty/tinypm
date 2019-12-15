const http = require('http');

process.stdin.resume();

http.createServer((req, res) => {
  res.writeHead(200);
  res.end('hello world ' + process.pid + '\n');
}).listen(8000, () => {
  setTimeout(() => {
    process.send('online');
  }, 3000)
});
