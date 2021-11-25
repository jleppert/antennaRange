#!/usr/bin/env node

require('module-alias/register');

var fs            = require('fs'),
    tmp           = require('tmp'),
    path          = require('path'),
    express       = require('express'),
    http          = require('http'),
    path          = require('path'),
    udp           = require('dgram'),
    dnode         = require('dnode'),
    sharp         = require('sharp'),
    uuid          = require('uuid').v4,
    shoe          = require('shoe'),
    spawn         = require('child_process').spawn,
    EventEmitter  = require('events'),
    SerialPort    = require('serialport'),
    ReadLine      = require('@serialport/parser-readline'),
    browserify    = require('browserify-middleware');

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
app.use(express.static('data'));

const rangeControllerPort = '/dev/ttyACM0';

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

var rangeResponse = rangeController.pipe(new ReadLine({ delimiter: '\n' }));

var rangeEvents = new EventEmitter();

rangeResponse.on('data', (data) => {
  console.log('response from controller', data.toString());

  if(!data.length) return;
  var status;
  try {
    status = JSON.parse(data.toString());
  } catch(e) {
    console.log('Error parsing range data', e.toString());
  }

  if(status) {
    updateRemoteStatus(status);
    if(status.message === 'state') rangeEvents.emit('state', status);
  }
});

var lastState, statusMessageLog = [], lastInitState = {};
function updateRemoteStatus(status) {
  if(status.message === 'state') {
    lastState = status;
  } else if(status.message === 'init') {
    lastInitState = status;    
  } else {
    statusMessageLog.push([Date.now(), status]);
  }
  
  Object.keys(remotes).forEach((id) => {
    var r = remotes[id];
    if(r && r.updateStatus) r.updateStatus(status);
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
    state: function(cb) {
      if(lastState && lastState.isBusy) {
        updateRemoteStatus(lastState);
        cb();

        return;
      }
      rangeController.write(JSON.stringify({ command: 'state' }) + '\n', (err) => {
        if(err) return cb(err.toString());
        cb();
      });
    },
    init: function(cb) {
      rangeController.write(JSON.stringify({ command: 'init' }) + '\n', (err) => {
        rangeController.close();
        if(err) return cb(err.toString());
        cb();

        initRange();
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
    if(lastState) {
      remote.updateStatus(lastState);
    } else {
      rangeController.write(JSON.stringify({ command: 'state' }) + '\n', (err) => {
        if(err) console.log('rangeController error fetching initial state', err);
      });
    }
  });

  d.pipe(stream).pipe(d);
});

sock.install(server, '/ws');

function initRange() {
  var frameCaptureInterval = 5000,
      capturedFrames = [],
      captureHandlerAttached = false;
  
  rangeEvents.on('state', monitorRange);


  function monitorRange(state) {
    var framePath = tmp.dirSync().name;

    if(state.hasHomed && !state.atHomePosition && !captureHandlerAttached) {
      console.log('Starting frame capture...');
      rangeEvents.on('frame', captureFrame);
      captureHandlerAttached = true;
    } else if(state.atHomePosition) {
      rangeEvents.off('state', monitorRange);
      rangeEvents.off('frame', captureFrame);
      console.log('Ended frame capture with count', capturedFrames.length);
    
      var writtenFrameCount = 0;
      capturedFrames.forEach((frame, index) => {
        var frameFilePath = path.join(framePath, `${index}.jpg`);

        fs.writeFile(frameFilePath, frame.data, (err) => {
          if(err) return console.log('Error writing frame', err);
          console.log('Wrote frame to path', frameFilePath);
          frame.filePath = frameFilePath;

          writtenFrameCount++;

          if(writtenFrameCount === capturedFrames.length) stitchFrames(framePath);
        });
      });
    }
  }

  const stitcher = path.join(__dirname, 'lib', 'OpenPano', 'src', 'image-stitching'),
        outputFilePath = path.join(__dirname, 'lib', 'OpenPano', 'src', 'out.jpg'),
        dataPath = path.join(__dirname, 'data');

  function stitchFrames(framePath) {
    console.log('Starting stitch of frames at path', framePath);
    
    try {
      fs.unlinkSync(outputFilePath);
    } catch(e) {}

    var stitcherProcess = spawn(stitcher, capturedFrames.sort((a, b) => { 
      return a.capturedAt - b.capturedAt })
    .map(f => f.filePath), {
      cwd: path.join(__dirname, 'lib', 'OpenPano', 'src')
    });

    stitcherProcess.on('spawn', () => {
      console.log('Stitcher process started');
    });
    
    stitcherProcess.stdout.on('data', (data) => {
      console.log(`stdout:\n${data}`);
    });

    stitcherProcess.stderr.on('data', (data) => {
      console.error(`stderr: ${data}`);
    });

    stitcherProcess.on('error', (error) => {
      console.error(`error: ${error.message}`);
    });

    stitcherProcess.on('close', (code) => {
      console.log(`Stitcher process process exited with code ${code}`);

      if(fs.existsSync(outputFilePath)) {
        console.log('Generated output mosaic', outputFilePath);
        
        var initStateMessage = { message: 'init', mosaicId: uuid() };
        
        fs.copyFile(outputFilePath, path.join(dataPath, initStateMessage.mosaicId), (err) => {
          if(err) return console.log('Error copying mosaic to data path', err);
          updateRemoteStatus(initStateMessage);
        });
      }
    });
  }

  var lastCapturedTime = 0;
  function captureFrame(frame) {
    if((Date.now() - lastCapturedTime) >= frameCaptureInterval || lastCapturedTime === 0) {
      console.log('Captured frame', capturedFrames.length, lastCapturedTime, Date.now());
      
      lastCapturedTime = Date.now();
      capturedFrames.push({ data: frame, state: lastState, capturedAt: lastCapturedTime });
    }
  }
}



var ws = require('ws');

var videoStreamingServer = new ws.WebSocketServer({ port: 5001, perMessageDeflate: false  });
videoStreamingServer.on('connection', () => {
  console.log('new video client connection');
});


var net = require('net');

var videoStream = net.Socket();

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
 
var frameBuffer = [];
videoStream.on('data', (data) => {
  //if(!videoStreamingServer.clients.length) return;
  
  const eoiPos = data.indexOf(EOI);
  const soiPos = data.indexOf(SOI);

  if (eoiPos === -1) {
    frameBuffer.push(data);
  } else {
    
    const part1 = data.slice(0, eoiPos + 2);
    if (part1.length) {
        frameBuffer.push(part1);
    }
    if (frameBuffer.length) {
      rangeEvents.emit('frame', Buffer.concat([...frameBuffer]));
    }
    
    frameBuffer = [];
  }
  if (soiPos > -1) {
    frameBuffer = [];
    const part2 = data.slice(soiPos)
    frameBuffer.push(part2);
  }
});

rangeEvents.on('frame', data => {
  sharp(data).resize({ kernel: 'nearest', width: 385, height: 250 }).toBuffer((err, resized, info) => {
    if(err) console.log(err, info);
    videoStreamingServer.clients.forEach((client) => {
      if(client.readyState === ws.WebSocket.OPEN) {
        client.send(resized, { binary: true });
      }
    });
  });
});

videoStream.on('error', (err) => {
  console.log('Error with video stream', err.toString()); 
});

//var videoProcess = spawn('ffmpeg', ['-f', 'v4l2', '-video_size', '1920x1080', '-i', '/dev/video0', '-f', 'mjpeg', `tcp://127.0.0.1:5000\?listen`]);
var videoProcess = spawn('gst-launch-1.0', 
  [
  'v4l2src', 
  'device=/dev/video0',
  '!',
  'capsfilter',
  'caps="image/jpeg, width=1920, height=1080"',
  '!',
  'tcpserversink',
  'host=127.0.0.1',
  'port=5000'
 ],
{ env: { GST_DEBUG: 3 } });


videoStream.hasConnected  = false;
videoProcess.on('spawn', () => {  

  function tryConnect() {
    if(videoStream.hasConnected) {
      return clearInterval(videoStream.reconnectIntervalId);
    }

    videoStream.on('error', (err) => {
      clearInterval(videoStream.reconnectIntervalId);
      videoStream.reconnectIntervalId = setInterval(tryConnect, 2000);
      console.log('Error with video stream', err.toString()); 
    });

    try {
      videoStream.connect(5000, () => {
        console.log('Video stream connected');
        videoStream.setNoDelay(true);
        videoStream.hasConnected = true;
        clearInterval(videoStream.reconnectIntervalId);
      });
    } catch(e) {
      console.log(e.toString());
      clearInterval(videoStream.reconnectIntervalId);
      videoStream.reconnectIntervalId = setInterval(tryConnect, 2000);
    }
  }

  tryConnect();
});


videoProcess.stdout.on('data', (data) => {
  console.log(`stdout:\n${data}`);
});

videoProcess.stderr.on('data', (data) => {
  console.error(`stderr: ${data}`);
});

videoProcess.on('error', (error) => {
  console.error(`error: ${error.message}`);
});

videoProcess.on('close', (code) => {
  console.log(`videoProcess process exited with code ${code}`);
});


if(require.main === module) {
  server.listen(3000, function() {
    console.log(`Antenna Range UI started on ${server.address().address}:${server.address().port}`);
  });
}
