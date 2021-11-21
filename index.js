#!/usr/bin/env node

require('module-alias/register');

var fs          = require('fs'),
    path        = require('path'),
    express     = require('express'),
    http        = require('http'),
    path        = require('path'),
    dnode       = require('dnode'),
    shoe        = require('shoe'),
    SerialPort  = require('serialport'),
    browserify  = require('browserify-middleware');

var app = express();
app.use('/client.js', browserify(path.join(__dirname, 'src', 'client.js')));

var styles = [
  path.join(__dirname, 'node_modules', 'toastify-js', 'src', 'toastify.css'),
  path.join(__dirname, 'node_modules', 'nprogress', 'nprogress.css')
];

app.use('/style.css', (req, res) => {
  res.status(200);
  res.setHeader('content-type', 'text/css');
  
  for(var stylePath of styles) {
    res.write(fs.readFileSync(stylePath));  
  }

  res.end();
});

app.use(express.static('static'));

const rangeControllerPort = '/dev/ttyACM1';

var rangeController = new SerialPort(rangeControllerPort, {
  baudRate: 9600
});

rangeController.on('close', () => {
  console.log('Range controller serial port closed, attempting reopen...');

  setTimeout(() => {
    try {
      rangeController.open((err) => {
        if(err) console.log('Failed to reopen serial port', err.toString());
      });
    } catch(e) {
      console.log('Exception opening port', e.toString());
      // TODO: look for other possible ports
    }
  }, 1000);
});

var remotes = {};

setInterval(() => {
  Object.keys(remotes).forEach((id) => {
    var r = remotes[id];
    
    if(!r || !r.lastPing || ((Date.now() - r.lastPing) > 60 * 1000)) {
      console.log('Client timed out', id, Date.now(), r.lastPing);
      delete remotes[id];
    }
  });
}, 30 * 1000);

rangeController.on('open', () => console.log('Opened range controller serial port'));
rangeController.on('error', (err) => console.log(`Range controller serial error: ${err.message}`));

rangeController.on('data', (data) => {
  console.log('response from controller', data.toString());

  data.toString().split('\n').forEach((message) => {
    if(!message.length) return;
    try {
      updateRemoteStatus(JSON.parse(message));
    } catch(e) {
      console.log('Error updating client status', e.toString());
    }
  });
});

function updateRemoteStatus(message) {
  Object.keys(remotes).forEach((id) => {
    var r = remotes[id];
    if(r && r.updateStatus) r.updateStatus(message);
  });
}

var server = http.createServer(app);

var sock = shoe(function(stream) {
  var remote;
  
  var d = dnode({
    home: function(cb) {
      rangeController.write(JSON.stringify({ command: 'home' }) + '\n', (err) => {
        if(err) return cb(err.toString());
        cb();
      });
    },
    move: function(cb, position) {
      rangeController.write(JSON.stringify({ command: 'move', position: position }) + '\n', (err) => {
        if(err) return cb(err.toString());
        cb();
      });
    },
    stop: function(cb) {
      rangeController.write(JSON.stringify({ command: 'stop' }) + '\n', (err) => {
        if(err) return cb(err.toString());
        cb();
      });
    },
    init: function(cb) {
      rangeController.write(JSON.stringify({ command: 'init' }) + '\n', (err) => {
        rangeController.close();
        if(err) return cb(err.toString());
        cb();
      });
    },
    ping: function() {
      var r = remotes[remote.id];
      if(r) r.lastPing = Date.now(); 
    }
  });

  d.on('remote', function(r) {
    r.id = Math.random();
    remote = r;

    remotes[r.id] = remote;

    console.log('New client connected', r.id, remotes);
  });

  d.pipe(stream).pipe(d);
});

sock.install(server, '/ws');

if(require.main === module) {
  server.listen(3000, function() {
    console.log(`Antenna Range UI started on ${server.address().address}:${server.address().port}`);
  });
}
