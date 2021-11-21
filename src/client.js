var dnode         = require('dnode'),
    shoe          = require('shoe'),
    reconnect     = require('reconnect/shoe'),
    progressBar   = require('nprogress'),
    notify        = require('toastify-js'),
    dat           = require('dat.gui');

var remote;
//var stream = shoe('/ws');

var connectionManager = reconnect((stream) => {
  var d = dnode({
    updateStatus: function(message) {
      console.log('got message', message);

      if(!message || !message.status) return;

      notify({
        text: message.status,
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

function callRemote(method) {
  return function(args = []) {
    args = Array.isArray(args) ? args : [args];

    args.unshift((err) => {
      progressBar.done();
      console.log('error!', err);
    });

    progressBar.start();
    method.apply(method, args);
  }
}

var gui;
function initUI() {
  var obj = {
    home: callRemote(remote.home),
    stop: callRemote(remote.stop),
    init: callRemote(remote.init),

    position: 0
  };

  if(gui) gui.destroy();
  gui = new dat.gui.GUI();

  var manualControls = gui.addFolder('Manual Control');
  
  manualControls.add(obj, 'init').name('Initialize Range');
  manualControls.add(obj, 'home').name('Home Position');
  manualControls.add(obj, 'stop').name('Stop Movement');

  manualControls.add(obj, 'position').name('Set Position')
    .min(0)
    .max(50000)
    .step(1)
    .onFinishChange(callRemote(remote.move));

  manualControls.open();
}
