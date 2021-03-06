var express = require('express');
var app = express();
var path = require('path');
var url = require('url');
var getAuth = require('basic-auth');
var parseurl = require('parseurl');
var bodyParser = require('body-parser');
var crypto = require('crypto');
var cookie = require('cookie');
var multer  = require('multer');
var htdocs = require('../htdocs');

var LIMIT_SIZE = 1024 * 1024 * 17;
var storage = multer.memoryStorage();
var upload = multer({
  storage: storage,
  fieldSize: LIMIT_SIZE
});

var DONT_CHECK_PATHS = ['/cgi-bin/server-info', '/cgi-bin/show-host-ip-in-res-headers',
                        '/cgi-bin/lookup-tunnel-dns', '/cgi-bin/rootca', '/cgi-bin/log/set'];
var PLUGIN_PATH_RE = /^\/(whistle|plugin)\.([a-z\d_\-]+)(\/)?/;
var STATIC_SRC_RE = /\.(?:ico|js|css|png)$/i;
var httpsUtil, proxyEvent, util, config, pluginMgr;
var MAX_AGE = 60 * 60 * 24 * 3;

function doNotCheckLogin(req) {
  var path = req.path;
  return STATIC_SRC_RE.test(path) || DONT_CHECK_PATHS.indexOf(path) !== -1;
}

function getUsername() {
  return config.username || '';
}

function getPassword() {
  return config.password || '';
}

function shasum(str) {
  var shasum = crypto.createHash('sha1');
  shasum.update(str || '');
  return shasum.digest('hex');
}

function getLoginKey (req, res, auth) {
  var ip = util.getClientIp(req);
  var password = auth.password;
  if (config.encrypted) {
    password = shasum(password);
  }
  return shasum([auth.username, password, ip].join('\n'));
}

function requireLogin(res) {
  res.setHeader('WWW-Authenticate', ' Basic realm=User Login');
  res.setHeader('Content-Type', 'text/html; charset=utf8');
  res.status(401).end('Access denied, please <a href="javascript:;" onclick="location.reload()">try again</a>.');
}

function checkAuth(req, res, auth) {
  var username = auth.username;
  var password = auth.password;
  var authKey = auth.authKey;

  if (!username && !password) {
    return true;
  }
  var cookies = cookie.parse(req.headers.cookie || '');
  var lkey = cookies[authKey];
  var correctKey = getLoginKey(req, res, auth);
  if (correctKey === lkey) {
    return true;
  }
  auth = getAuth(req) || {};
  if (config.encrypted) {
    auth.pass = shasum(auth.pass);
  }
  if (auth.name === username && auth.pass === password) {
    var options = {
      expires: new Date(Date.now() + (MAX_AGE * 1000)),
      maxAge: MAX_AGE,
      path: '/'
    };
    res.setHeader('Set-Cookie', cookie.serialize(authKey, correctKey, options));
    return true;
  }
  requireLogin(res);
  return false;
}

app.use(function(req, res, next) {
  proxyEvent.emit('_request', req.url);
  var aborted;
  req.on('error', abort).on('close', abort);
  res.on('error', abort);
  function abort() {
    if (!aborted) {
      aborted = true;
      res.destroy();
    }
  }
  var referer = req.headers.referer;
  var options = parseurl(req);
  if (!PLUGIN_PATH_RE.test(options.pathname)) {
    if (referer) {
      var refOpts = url.parse(referer);
      var pathname = refOpts.pathname;
      if (PLUGIN_PATH_RE.test(pathname) && RegExp.$3) {
        req.url = '/' + RegExp.$1 + '.' + RegExp.$2 + options.path;
      }else if (config.isNohostUrl(refOpts.hostname) === 2) {
        req.url = '/whistle.nohost' + options.path;
      }
    } else if (config.isNohostUrl(req.headers.host) === 2) {
      req.url = '/whistle.nohost' + options.path;
    }
  }

  next();
});

app.use(function(req, res, next) {
  if (req.headers.host !== 'rootca.pro') {
    return next();
  }
  res.download(httpsUtil.getRootCAFile(), 'rootCA.crt');
});

function cgiHandler(req, res) {
  try {
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Access-Control-Allow-Credentials', true);
    }
    require(path.join(__dirname, '..' + req.path))(req, res);
  } catch(err) {
    res.status(500).send(util.getErrorStack(err));
  }
}

app.all('/cgi-bin/sessions/*', cgiHandler);
app.all('/favicon.ico', function(req, res) {
  res.sendFile(htdocs.getImgFile('favicon.ico'));
});
app.all(PLUGIN_PATH_RE, function(req, res, next) {
  var result = PLUGIN_PATH_RE.exec(req.url);
  var type = result[1];
  var name = result[2];
  var slash = result[3];
  var plugin = type === 'whistle' ? pluginMgr.getPlugin(name + ':')
    : pluginMgr.getPluginByName(name);
  if (!plugin) {
    return res.status(404).send('Not Found');
  }
  if (!slash) {
    return res.redirect(type + '.' + name + '/');
  }
  pluginMgr.loadPlugin(plugin, function(err, ports) {
    if (err || !ports.uiPort) {
      res.status(err ? 500 : 404).send(err || 'Not Found');
      return;
    }
    var options = parseurl(req);
    req.url = options.path.replace(result[0].slice(0, -1), '');
    util.transformReq(req, res, ports.uiPort);
  });
});

app.use(function(req, res, next) {
  if (doNotCheckLogin(req)) {
    return next();
  }
  var username = getUsername();
  var password = getPassword();
  var authConf = {
    authKey: 'whistle_lk_' + encodeURIComponent(username),
    username: username,
    password: password
  };
  if (checkAuth(req, res, authConf)) {
    next();
  }
});
app.post('/cgi-bin/socket/upload', upload.single('data'), function(req, res) {
  res.json({ec: 0});
});
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb'}));
app.use(bodyParser.json());

app.all('/cgi-bin/*', cgiHandler);

app.use(express.static(path.join(__dirname, '../htdocs'), {maxAge: 300000}));

app.get('/', function(req, res) {
  res.sendFile(htdocs.getHtmlFile('index.html'));
});

app.all(/^\/weinre\/.*/, function(req, res) {
  var options = parseurl(req);
  if (options.pathname === '/weinre/client') {
    return res.redirect('client/' + (options.search || ''));
  }
  req.url = options.path.replace('/weinre', '');
  util.transformReq(req, res, config.weinreport, true);
});

module.exports = function(proxy) {
  proxyEvent = proxy;
  config = proxy.config;
  pluginMgr = proxy.pluginMgr;
  var rulesUtil = proxy.rulesUtil;

  require('./proxy')(proxy);
  require('./util')(util = proxy.util);
  require('./config')(config);
  require('./rules-util')(rulesUtil);
  require('./rules')(rulesUtil.rules);
  require('./properties')(rulesUtil.properties);
  require('./values')(rulesUtil.values);
  require('./https-util')(httpsUtil = proxy.httpsUtil);
  require('./data')(proxy);
  app.listen(config.uiport);
};
