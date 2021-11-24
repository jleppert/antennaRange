var dnode         = require('dnode'),
    shoe          = require('shoe'),
    reconnect     = require('reconnect/shoe'),
    progressBar   = require('nprogress'),
    notify        = require('toastify-js'),
    dat           = require('dat.gui');

var cameraEl = document.createElement('canvas'),
    ctx      = cameraEl.getContext('2d');


var videoSocket;
function connectVideo() {
  if(videoSocket) {
    videoSocket.close();
  }
  
  videoSocket = new WebSocket(`ws://${document.location.hostname}:5001`);
  
  function frameReceived(message) {
    var frame = new Image();
    
    frame.onload = function() {
      ctx.drawImage(frame, 0, 0);
    }

    frame.src = URL.createObjectURL(message.data);
  }
  
  videoSocket.removeEventListener('message', frameReceived);
  videoSocket.addEventListener('message', frameReceived);
}
  
cameraEl.width = 385;
cameraEl.height = 250;  

var stateUI = {
  isBusy: document.createElement('div')
};

Object.keys(stateUI).forEach((key) => {
  var el = stateUI[key];
  el.classList.add('state');
  el.classList.add(key);

  document.body.appendChild(el);
});

function updateState(state) {
  if(state.isBusy) {
    stateUI.isBusy.classList.remove('false');
    stateUI.isBusy.classList.add('true');
  } else {
    stateUI.isBusy.classList.remove('true');
    stateUI.isBusy.classList.add('false');
  }

  if(state.hasHomed) updatePositionSetPointControl(0, state.maxPositionInEncoderSteps);
  controllers.position.setValue(state.currentSetPosition);
}

var remote;

var connectionManager = reconnect((stream) => {
  var d = dnode({
    updateStatus: function(status) {
      if(!status || !status.message) return;
      if(status.message === 'state') return updateState(status);
      
      if(status.isBusy) {
        stateUI.isBusy.classList.add('true');
      } else {
        stateUI.isBusy.classList.remove('true');
        stateUI.isBusy.classList.add('false');
      }

      notify({
        text: status.message,
        duration: 3000,
        close: false,
        gravity: 'bottom',
        position: 'left',
        stopOnFocus: false,
        style: {
          background: 'linear-gradient(to right, #00b09b, #96c93d)',
        },
      }).showToast();
    }
  });

  var pingIntervalId;
  d.on('remote', function(r) {
    remote = r;

    initUI();

    if(pingIntervalId) clearInterval(pingIntervalId);
    pingIntervalId = setInterval(() => {
      remote.ping();
    }, 5000);
  });

  d.pipe(stream).pipe(d);

}).connect('/ws');

connectionManager.on('connect', () => {
  connectVideo(); 
  
  if(retryNotify) retryNotify.hideToast();
  notify({
    text: 'Connected.',
    duration: 3000,
    close: false,
    gravity: 'bottom',
    position: 'left',
    stopOnFocus: false,
    style: {
      background: 'linear-gradient(to right, #00b09b, #96c93d)',
    },
  }).showToast();
});

connectionManager.on('disconnect', () => {
  notify({
    text: 'Disconnected.',
    duration: 3000,
    close: false,
    gravity: 'bottom',
    position: 'left',
    stopOnFocus: false,
    style: {
      background: 'linear-gradient(to right, #00b09b, #96c93d)',
    },
  }).showToast();
});

var retryNotify;
connectionManager.on('reconnect', () => {
  retryNotify = notify({
    text: 'Trying to reconnect...',
    duration: 3000,
    close: false,
    gravity: 'bottom',
    position: 'left',
    stopOnFocus: false,
    style: {
      background: 'linear-gradient(to right, #00b09b, #96c93d)',
    },
  }).showToast();
});

function callRemote(method, done = function() {}) {
  return function(args = []) {
    args = Array.isArray(args) ? args : [args];

    args.unshift((err) => {
      progressBar.done();
      done.apply(done, arguments);
    });

    progressBar.start();
    method.apply(method, args);
  }
}

var gui, 
    stateObj, 
    scanTarget, 
    manualControls,
    scanControls, 
    controllers = {};

window.controllers = controllers;

function updatePositionSetPointControl(min, max) {
  var control = controllers.position || manualControls.add(stateObj, 'position').name('Set Position')
    .min(min)
    .max(max)
    .step(1)
    .onFinishChange(callRemote(remote.move));

  control.min(min);
  control.max(max);

  controllers.position = control;
}

function initUI() {
  if(gui) gui.destroy();
  gui = new dat.gui.GUI({ width: 400 });
  gui.domElement.parentElement.style.top = '40px';

  stateObj = {
    scanTarget: {
      name: 'Calibration'
    },

    home: callRemote(remote.home),
    stop: callRemote(remote.stop),
    init: callRemote(remote.init),

    position: 0,
    stepResolution: 2000,
    samplesPerStep: 10,
    
    startPosition: 0,
    endPosition: 0,
    
    startFrequency: 1000,
    endFrequency: 3000,
    ifbw: 5000,
    outputPower: 20,

    antenna: ['dipole-a', 'dipole-b', 'dipole-c'],

    runScan: callRemote(remote.home)

  };

  scanTarget = gui.addFolder('Scan Target');
  var scanTargetName = scanTarget.add(stateObj.scanTarget, 'name').name('Description');
  scanTargetName.__li.prepend(cameraEl); 
  scanTargetName.__li.style.height = '280px';
  window.t = scanTargetName;
  scanTarget.open();

  manualControls = gui.addFolder('Manual Control');
  manualControls.add(stateObj, 'init').name('Initialize Range');
  manualControls.add(stateObj, 'home').name('Home Position');
  manualControls.add(stateObj, 'stop').name('Stop Movement');

  manualControls.open();

  scanControls = gui.addFolder('Scan Control');
  scanControls.add(stateObj, 'stepResolution').name('Step Resolution');
  scanControls.add(stateObj, 'samplesPerStep').name('Samples Per Step');
  scanControls.add(stateObj, 'startPosition').name('Start Position');
  scanControls.add(stateObj, 'endPosition').name('End Position');
  scanControls.add(stateObj, 'startFrequency').name('Start Frequency');
  scanControls.add(stateObj, 'endFrequency').name('End Frequency');
  scanControls.add(stateObj, 'ifbw').name('IFBW');
  scanControls.add(stateObj, 'outputPower').name('Output Power');
  scanControls.add(stateObj, 'runScan').name('Run Scan');

  scanControls.open();


}
