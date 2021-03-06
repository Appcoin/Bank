/* eslint-disable no-console */
/* eslint-disable no-prototype-builtins */
/* eslint-disable prefer-destructuring */
/* eslint consistent-return:0 import/order:0 */
const express = require('express');
const logger = require('./utils/logger');
// const sio_redis = require('socket.io-redis');
const argv = require('./utils/argv');
const port = require('./utils/port');
const setup = require('./middlewares/frontend.middleware');
const morgan = require('morgan');
const newError = require('http-errors');
const cors = require('cors');
const isDev = process.env.NODE_ENV !== 'production';
const ngrok =
  (isDev && process.env.ENABLE_TUNNEL) || argv.tunnel
    ? require('ngrok')
    : false;
const { resolve } = require('path');
const bodyParser = require('body-parser');
const app = express();
const server = require('http').Server(app, {
  transports: ['websocket', 'polling'],
});
const io = require('socket.io')(server, { pingTimeout: 60000 });
const cron = require('node-cron');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = require('./utils/swagger.json');
const db = require('./config/db.config');
const env = require('./config/env.config');
const Op = db.Sequelize.Op;
const cookieParser = require('cookie-parser');
const csrf = require('csurf');

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(
  bodyParser.json({
    limit: '2000kb',
  }),
);
app.disable('x-powered-by');
app.use(cors());
app.use(cookieParser());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization',
  );

  if (req.method === 'OPTIONS') {
    res.header('Access-Control-Allow-Methods', 'PUT, POST, PATCH, DELETE, GET');
    return res.status(200).json({});
  }
  next();
});

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
app.use(morgan('dev'));

require('./routes/currency.route.js')(app);
if (!isDev) {
  app.use(csrf({ cookie: true }));
  app.use((req, res, next) => {
    res.cookie('XSRF-TOKEN', req.csrfToken());
    res.locals.csrftoken = req.csrfToken();
    next();
  });
}

require('./routes/user.route.js')(app);
require('./routes/transaction.route.js')(app);
require('./routes/bill.route.js')(app);
require('./routes/additional.route.js')(app);

// In production we need to pass these values in instead of relying on webpack
setup(app, {
  outputPath: resolve(process.cwd(), 'build'),
  publicPath: '/',
});

// get the intended host and port number, use localhost and port 3000 if not provided
const customHost = argv.host || process.env.HOST;
const host = customHost || null; // Let http.Server use its default IPv6/4 host
const prettyHost = customHost || 'localhost';

db.sequelize.sync({ force: !!isDev }).then(() => {
  createNecessaryTables();
});

// Crons Schedule
cron.schedule('0 0 */1 * * *', () => {
  require('./crons/currency.cron.js')();
});

// use the gzipped bundle
app.get('*.js', (req, res, next) => {
  req.url = req.url + '.gz'; // eslint-disable-line
  res.set('Content-Encoding', 'gzip');
  next();
});
// io.adapter(sio_redis({ host: 'localhost', port: 6379 })); // uncomment if you want to support the cluster
io.on('connection', socket => {
  socket.on('new notification', id => {
    io.sockets.emit('new notification', id);
  });

  socket.on('disconnect', () => {
    io.emit('user disconnected');
  });
});

// Error handler
app.use((error, res) => {
  if (error.hasOwnProperty('expose')) {
    console.error(new Date(), error);
    res.status(error.status);
    return res.json({ error: newError(error.status).message, result: null });
  }
  res.status(error.status);
  return res.json({ error: error.message, result: null });
});

// Start your app.
server.listen(port, host, async err => {
  if (err) {
    return logger.error(err.message);
  }

  // Connect to ngrok in dev mode
  if (ngrok) {
    let url;
    try {
      url = await ngrok.connect(port);
    } catch (e) {
      return logger.error(e);
    }
    logger.appStarted(port, prettyHost, url);

    // console.log('url', url);
  } else {
    logger.appStarted(port, prettyHost);
  }
});

// uncomment if you want to support the cluster \/
// process.on('message', (message, connection) => {
//   if (message !== 'sticky-session:connection') {
//     return;
//   }
//   server.emit('connection', connection);

//   connection.resume();
// });

function createNecessaryTables() {
  db.currency
    .findOne({
      where: {
        id: {
          [Op.or]: [1, 2, 3],
        },
      },
    })
    .then(isCurrency => {
      if (!isCurrency) {
        require('./crons/currency.cron.js')();
        try {
          Promise.all([
            db.currency.create({
              id: 1,
              currency: 'USD',
              date_currency_exchange_rate_sync: new Date(),
              main_currency: 0,
            }),
            db.currency.create({
              id: 2,
              currency: 'PLN',
              date_currency_exchange_rate_sync: new Date(),
              main_currency: 1,
            }),
            db.currency.create({
              id: 3,
              currency: 'EUR',
              date_currency_exchange_rate_sync: new Date(),
              main_currency: 0,
            }),
          ]).then(currency => {
            if (currency) {
              db.users
                .create({
                  login: env.adminAccount.login,
                  password: env.adminAccount.password,
                  name: env.adminAccount.name,
                  surname: env.adminAccount.surname,
                  email: env.adminAccount.email,
                  date_registration: new Date(),
                })
                .then(user => {
                  if (user) {
                    db.bills
                      .create({
                        id_owner: user.id,
                        account_bill: env.adminAccount.account_bill,
                        available_funds: env.adminAccount.available_funds,
                        id_currency: 1,
                      })
                      .then(bill => {
                        if (bill) {
                          db.additionals.create({
                            id_owner: bill.id_owner,
                            id_currency: bill.id_currency,
                            account_balance_history:
                              env.adminAccount.account_balance_history,
                            incoming_transfers_sum:
                              env.adminAccount.incoming_transfers_sum,
                            outgoing_transfers_sum:
                              env.adminAccount.outgoing_transfers_sum,
                          });
                        }
                      });
                  }
                });
            }
          });
        } catch (e) {
          /* just ignore */
        }
      }
    });
}
