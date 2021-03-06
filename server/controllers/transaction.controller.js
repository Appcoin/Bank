/* eslint-disable indent */
/* eslint-disable prefer-destructuring */
/* eslint-disable no-else-return */
const nodemailer = require('nodemailer');
const { validationResult } = require('express-validator/check');
const newError = require('http-errors');
const db = require('../config/db.config.js');
const env = require('../config/env.config.js');
const Transaction = db.transactions;
const Bill = db.bills;
const Additional = db.additionals;
const User = db.users;
const Currency = db.currency;
const Op = db.Sequelize.Op;

exports.confirm = (req, res, next) => {
  function getTodayDate() {
    const today = new Date();
    return today;
  }

  function getPreviousMonthDate(today) {
    const previousMonth = new Date();
    previousMonth.setMonth(today.getMonth() - 1);
    return previousMonth;
  }

  function setAuthorizationStatus(status) {
    const authorizationStatus = status;
    return authorizationStatus;
  }

  async function getCurrencyId(id_owner) {
    try {
      const isCurrency = await Bill.findOne({
        where: {
          id_owner,
        },
      });
      return isCurrency.id_currency;
    } catch (e) {
      /* just ignore */
    }
  }

  async function isCurrencyMain(id) {
    try {
      const currencyMain = await Currency.findOne({
        where: {
          id,
        },
      });
      return currencyMain.main_currency;
    } catch (e) {
      /* just ignore */
    }
  }

  async function getCurrencyExchangeRate(currencyId) {
    try {
      const isCurrencyExchangeRate = await Currency.findOne({
        where: {
          id: currencyId,
        },
      });
      return isCurrencyExchangeRate.currency_exchange_rate;
    } catch (e) {
      /* just ignore */
    }
  }

  async function setAvailableFunds(
    senderId,
    recipientId,
    senderAvailableFunds,
    recipientAvailableFunds,
    amountMoney,
    transferCurrencyId,
  ) {
    try {
      await subAvailableFunds(senderAvailableFunds, amountMoney, senderId);
      await addAvailableFunds(
        recipientAvailableFunds,
        amountMoney,
        recipientId,
        transferCurrencyId,
      );
    } catch (e) {
      /* just ignore */
    }
  }

  function subAvailableFunds(senderAvailableFunds, amountMoney, senderId) {
    return Bill.update(
      {
        available_funds: (
          parseFloat(senderAvailableFunds) - parseFloat(amountMoney)
        ).toFixed(2),
      },
      { where: { id_owner: senderId } },
    );
  }

  async function addAvailableFunds(
    recipientAvailableFunds,
    amountMoney,
    recipientId,
    transferCurrencyId,
  ) {
    try {
      const recipientCurrencyId = await getCurrencyId(recipientId);

      if (recipientCurrencyId === transferCurrencyId) {
        return Bill.update(
          {
            available_funds: (
              parseFloat(recipientAvailableFunds) + parseFloat(amountMoney)
            ).toFixed(2),
          },
          { where: { id_owner: recipientId } },
        );
      } else {
        Currency.findOne({
          where: {
            id: recipientCurrencyId,
          },
        }).then(isRecipientCurrencyId => {
          if (isRecipientCurrencyId) {
            const mainCurrency = isRecipientCurrencyId.main_currency;
            const recipientCurrencyExchangeRate =
              isRecipientCurrencyId.currency_exchange_rate;

            Currency.findOne({
              where: {
                id: transferCurrencyId,
              },
            }).then(isTransferCurrencyId => {
              if (isTransferCurrencyId) {
                const transferCurrencyExchangeRate =
                  isTransferCurrencyId.currency_exchange_rate;

                if (mainCurrency) {
                  const convertedAmountMoney =
                    amountMoney / transferCurrencyExchangeRate;

                  return Bill.update(
                    {
                      available_funds: (
                        parseFloat(recipientAvailableFunds) +
                        parseFloat(convertedAmountMoney)
                      ).toFixed(2),
                    },
                    { where: { id_owner: recipientId } },
                  );
                } else {
                  const convertedAmountMoney =
                    (amountMoney / transferCurrencyExchangeRate) *
                    recipientCurrencyExchangeRate;
                  return Bill.update(
                    {
                      available_funds: (
                        parseFloat(recipientAvailableFunds) +
                        parseFloat(convertedAmountMoney)
                      ).toFixed(2),
                    },
                    { where: { id_owner: recipientId } },
                  );
                }
              }
            });
          }
        });
      }
    } catch (e) {
      /* just ignore */
    }
  }

  async function setTransferHistory(
    senderId,
    recipientId,
    amountMoney,
    transferTitle,
    authorizationKey,
  ) {
    try {
      return Transaction.update(
        {
          authorization_status: setAuthorizationStatus(1),
          date_time: getTodayDate(),
        },
        {
          where: {
            id_sender: senderId,
            id_recipient: recipientId,
            amount_money: amountMoney,
            id_currency: await getCurrencyId(senderId),
            transfer_title: transferTitle,
            authorization_key: authorizationKey,
            authorization_status: setAuthorizationStatus(0),
          },
        },
      );
    } catch (e) {
      /* just ignore */
    }
  }

  // TODO: always prepend 0, but balance history is only from the last month
  function setWidgetStatus(userId) {
    Transaction.findAll({
      where: db.Sequelize.and(
        {
          date_time: {
            [Op.between]: [
              getPreviousMonthDate(getTodayDate()),
              getTodayDate(),
            ],
          },
          authorization_status: setAuthorizationStatus(1),
        },
        db.Sequelize.or({ id_sender: userId }, { id_recipient: userId }),
      ),
      order: [['date_time', 'ASC']],
    }).then(async transactionsHistory => {
      if (transactionsHistory) {
        let transferCurrencyExchangeRate = null;
        let convertedAmountMoney = null;
        let availableFunds = 0;
        let accountBalanceHistory = '0';
        let incomingTransfersSum = 0;
        let outgoingTransfersSum = 0;
        const userCurrencyId = await getCurrencyId(userId);
        const mainCurrency = await isCurrencyMain(userCurrencyId);
        const userCurrencyExchangeRate = await getCurrencyExchangeRate(
          userCurrencyId,
        );

        // eslint-disable-next-line no-restricted-syntax
        for await (const transactionHistory of transactionsHistory) {
          if (transactionHistory.id_sender === userId) {
            if (transactionHistory.id_currency === userCurrencyId) {
              outgoingTransfersSum += transactionHistory.amount_money;
              availableFunds -= transactionHistory.amount_money;
              accountBalanceHistory += `,${availableFunds.toFixed(2)}`;
            } else {
              try {
                await Promise.all(
                  (transferCurrencyExchangeRate = await getCurrencyExchangeRate(
                    transactionHistory.id_currency,
                  )),
                );

                if (mainCurrency) {
                  convertedAmountMoney =
                    transactionHistory.amount_money /
                    transferCurrencyExchangeRate;

                  outgoingTransfersSum += convertedAmountMoney;
                  availableFunds -= convertedAmountMoney;
                  accountBalanceHistory += `,${availableFunds.toFixed(2)}`;
                } else {
                  convertedAmountMoney =
                    (transactionHistory.amount_money /
                      transferCurrencyExchangeRate) *
                    userCurrencyExchangeRate;

                  outgoingTransfersSum += convertedAmountMoney;
                  availableFunds -= convertedAmountMoney;
                  accountBalanceHistory += `,${availableFunds.toFixed(2)}`;
                }
              } catch (e) {
                /* just ignore */
              }
            }
          }

          if (transactionHistory.id_recipient === userId) {
            if (transactionHistory.id_currency === userCurrencyId) {
              incomingTransfersSum += transactionHistory.amount_money;
              availableFunds += transactionHistory.amount_money;
              accountBalanceHistory += `,${availableFunds.toFixed(2)}`;
            } else {
              transferCurrencyExchangeRate = await getCurrencyExchangeRate(
                transactionHistory.id_currency,
              );

              if (mainCurrency) {
                convertedAmountMoney =
                  transactionHistory.amount_money /
                  transferCurrencyExchangeRate;

                incomingTransfersSum += convertedAmountMoney;
                availableFunds += convertedAmountMoney;
                accountBalanceHistory += `,${availableFunds.toFixed(2)}`;
              } else {
                convertedAmountMoney =
                  (transactionHistory.amount_money /
                    transferCurrencyExchangeRate) *
                  userCurrencyExchangeRate;

                incomingTransfersSum += convertedAmountMoney;
                availableFunds += convertedAmountMoney;
                accountBalanceHistory += `,${availableFunds.toFixed(2)}`;
              }
            }
          }
        }

        Additional.update(
          {
            account_balance_history: accountBalanceHistory,
            outgoing_transfers_sum: outgoingTransfersSum.toFixed(2),
            incoming_transfers_sum: incomingTransfersSum.toFixed(2),
          },
          { where: { id_owner: userId } },
        );
      }
    });
  }

  function setNotification(id_owner) {
    Additional.findOne({
      where: {
        id_owner,
      },
    }).then(isAdditional => {
      if (isAdditional) {
        const notificationCount = isAdditional.notification_count;

        return Additional.update(
          {
            notification_status: 1,
            notification_count: notificationCount + 1,
          },
          { where: { id_owner } },
        );
      }
    });
  }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(newError(422, errors.array()));
  }

  Bill.findOne({
    where: {
      account_bill: req.body.account_bill,
    },
  }).then(isAccountBill => {
    if (isAccountBill) {
      const recipientId = isAccountBill.id_owner;
      const senderId = req.body.id_sender;
      const recipientAvailableFunds = isAccountBill.available_funds;
      const amountMoney = req.body.amount_money;
      const transferTitle = req.body.transfer_title;
      const authorizationKey = req.body.authorization_key;

      if (recipientId !== senderId) {
        Bill.findOne({
          where: {
            id_owner: senderId,
          },
        }).then(async isAvailableFunds => {
          if (isAvailableFunds) {
            const senderAvailableFunds = isAvailableFunds.available_funds;
            if (senderAvailableFunds >= amountMoney && amountMoney > 0) {
              Transaction.findOne({
                where: {
                  id_sender: senderId,
                  id_recipient: recipientId,
                  amount_money: amountMoney,
                  id_currency: await getCurrencyId(senderId),
                  transfer_title: transferTitle,
                  authorization_key: authorizationKey,
                  authorization_status: setAuthorizationStatus(0),
                },
                order: [['date_time', 'DESC']],
              }).then(async isRegisteredTransfer => {
                if (
                  isRegisteredTransfer &&
                  isRegisteredTransfer.authorization_key === authorizationKey
                ) {
                  const transferCurrencyId = isRegisteredTransfer.id_currency;
                  Promise.all([
                    await setAvailableFunds(
                      senderId,
                      recipientId,
                      senderAvailableFunds,
                      recipientAvailableFunds,
                      amountMoney,
                      transferCurrencyId,
                    ),
                    await setTransferHistory(
                      senderId,
                      recipientId,
                      amountMoney,
                      transferTitle,
                      authorizationKey,
                    ),
                  ]).then(async isPaymentSuccess => {
                    if (isPaymentSuccess) {
                      Promise.all([
                        setWidgetStatus(senderId),
                        setWidgetStatus(recipientId),
                        setNotification(recipientId),
                      ]).then(isNotificationSuccess => {
                        if (isNotificationSuccess) {
                          return res.status(200).json({ success: true });
                        }
                      });
                    }
                  });
                } else {
                  return res.status(200).json({
                    error:
                      'Incorrect authorization key or unregistered payment',
                    success: false,
                  });
                }
              });
            } else {
              return res.status(200).json({
                error: 'Sender does not have enough money',
                success: false,
              });
            }
          } else {
            return res
              .status(200)
              .json({ error: 'Sender does not exist', success: false });
          }
        });
      } else {
        return res
          .status(200)
          .json({ error: 'Attempt payment to myself', success: false });
      }
    } else {
      return res
        .status(200)
        .json({ error: 'Recipient does not exist', success: false });
    }
  });
};

exports.register = (req, res, next) => {
  function getTodayDate() {
    const today = new Date();
    return today;
  }

  function setAuthorizationStatus(status) {
    const authorizationStatus = status;
    return authorizationStatus;
  }

  async function getCurrencyId(id_sender) {
    try {
      const isCurrency = await Bill.findOne({
        where: {
          id_owner: id_sender,
        },
      });
      return isCurrency.id_currency;
    } catch (e) {
      /* just ignore */
    }
  }

  async function getCurrencyName(id) {
    try {
      const isCurrencyName = await Currency.findOne({
        where: {
          id,
        },
      });
      return isCurrencyName.currency;
    } catch (e) {
      /* just ignore */
    }
  }

  async function getSenderEmail(id) {
    try {
      const isUser = await User.findOne({
        where: {
          id,
        },
      });
      return isUser.email;
    } catch (e) {
      /* just ignore */
    }
  }

  async function getRecipientName(id) {
    try {
      const isUser = await User.findOne({
        where: {
          id,
        },
      });
      return `${isUser.name} ${isUser.surname}`;
    } catch (e) {
      /* just ignore */
    }
  }

  function setAuthorizationKey() {
    let authorizationKey = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

    for (let i = 0; i < 5; i++) {
      authorizationKey += possible.charAt(
        Math.floor(Math.random() * possible.length),
      );
    }

    return authorizationKey;
  }

  async function sendAuthorizationKey(
    senderId,
    recipientId,
    amountMoney,
    authorizationKey,
    currencyId,
  ) {
    const currencyName = await getCurrencyName(currencyId);
    const recipientName = await getRecipientName(recipientId);
    const senderName = await getSenderEmail(senderId);

    await nodemailer.createTestAccount();
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: env.nodemailer.username,
        pass: env.nodemailer.password,
      },
    });

    const mailOptions = {
      from: `"Bank Application" <${env.nodemailer.email}>`,
      to: `${senderName}`,
      subject: 'Payment authorization',
      text: `Dear Customer! We have registered an attempt to make a payment for the amount of: ${amountMoney
        .toFixed(2)
        .toString()
        .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
        .replace('.', ',')} ${currencyName} to ${recipientName}.
      Confirm the payment by entering the authorization key: ${authorizationKey}`,
      html: `<!doctype html>
      <html xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
      
      <head>
        <title> </title>
        <!--[if !mso]><!-- -->
        <meta http-equiv="X-UA-Compatible" content="IE=edge">
        <!--<![endif]-->
        <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style type="text/css">
          #outlook a {
            padding: 0;
          }
      
          .ReadMsgBody {
            width: 100%;
          }
      
          .ExternalClass {
            width: 100%;
          }
      
          .ExternalClass * {
            line-height: 100%;
          }
      
          body {
            margin: 0;
            padding: 0;
            -webkit-text-size-adjust: 100%;
            -ms-text-size-adjust: 100%;
          }
      
          table,
          td {
            border-collapse: collapse;
            mso-table-lspace: 0pt;
            mso-table-rspace: 0pt;
          }
      
          img {
            border: 0;
            height: auto;
            line-height: 100%;
            outline: none;
            text-decoration: none;
            -ms-interpolation-mode: bicubic;
          }
      
          p {
            display: block;
            margin: 13px 0;
          }
        </style>
        <!--[if !mso]><!-->
        <style type="text/css">
          @media only screen and (max-width:480px) {
            @-ms-viewport {
              width: 320px;
            }
            @viewport {
              width: 320px;
            }
          }
        </style>
        <!--<![endif]-->
        <!--[if mso]>
              <xml>
              <o:OfficeDocumentSettings>
                <o:AllowPNG/>
                <o:PixelsPerInch>96</o:PixelsPerInch>
              </o:OfficeDocumentSettings>
              </xml>
              <![endif]-->
        <!--[if lte mso 11]>
              <style type="text/css">
                .outlook-group-fix { width:100% !important; }
              </style>
              <![endif]-->
        <style type="text/css">
          @media only screen and (min-width:480px) {
            .mj-column-per-100 {
              width: 100% !important;
              max-width: 100%;
            }
          }
        </style>
        <style type="text/css">
          @media only screen and (max-width:480px) {
            table.full-width-mobile {
              width: 100% !important;
            }
            td.full-width-mobile {
              width: auto !important;
            }
          }
        </style>
      </head>
      
      <body>
        <div>
          <!--[if mso | IE]>
            <table
               align="center" border="0" cellpadding="0" cellspacing="0" class="" style="width:600px;" width="600"
            >
              <tr>
                <td style="line-height:0px;font-size:0px;mso-line-height-rule:exactly;">
            <![endif]-->
          <div style="Margin:0px auto;max-width:600px;">
            <table align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="width:100%;">
              <tbody>
                <tr>
                  <td style="direction:ltr;font-size:0px;padding:20px 0;text-align:center;vertical-align:top;">
                    <!--[if mso | IE]>
                        <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                      
              <tr>
            
                  <td
                     class="" style="vertical-align:top;width:600px;"
                  >
                <![endif]-->
                    <div class="mj-column-per-100 outlook-group-fix" style="font-size:13px;text-align:left;direction:ltr;display:inline-block;vertical-align:top;width:100%;">
                      <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="vertical-align:top;" width="100%">
                        <tr>
                          <td align="center" style="font-size:0px;padding:10px 25px;word-break:break-word;">
                            <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;border-spacing:0px;">
                              <tbody>
                                <tr>
                                  <td style="width:200px;"> <img height="auto" src="https://maxrec.pl/img/logobank.jpg" style="border:0;display:block;outline:none;text-decoration:none;height:auto;width:100%;" width="200" /> </td>
                                </tr>
                              </tbody>
                            </table>
                          </td>
                        </tr>
                        <tr>
                          <td style="font-size:0px;padding:10px 25px;word-break:break-word;">
                            <p style="border-top:solid 4px #15a0dd;font-size:1;margin:0px auto;width:100%;"> </p>
                            <!--[if mso | IE]>
              <table
                 align="center" border="0" cellpadding="0" cellspacing="0" style="border-top:solid 4px #15a0dd;font-size:1;margin:0px auto;width:550px;" role="presentation" width="550px"
              >
                <tr>
                  <td style="height:0;line-height:0;">
                    &nbsp;
                  </td>
                </tr>
              </table>
            <![endif]-->
                          </td>
                        </tr>
                        <tr>
                          <td align="left" style="font-size:0px;padding:10px 25px;word-break:break-word;">
                            <div style="font-family:helvetica;font-size:16px;line-height:1;text-align:left;color:black;"> Dear Customer! <br /> We have registered an attempt to make a payment for the amount of ${amountMoney
                              .toFixed(2)
                              .toString()
                              .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
                              .replace(
                                '.',
                                ',',
                              )} ${currencyName} to ${recipientName}. <br /><br /> Confirm the payment by entering the authorization key: <b>${authorizationKey}</b>                        </div>
                          </td>
                        </tr>
                        <tr>
                          <td style="font-size:0px;padding:10px 25px;word-break:break-word;">
                            <p style="border-top:solid 4px #15a0dd;font-size:1;margin:0px auto;width:100%;"> </p>
                            <!--[if mso | IE]>
              <table
                 align="center" border="0" cellpadding="0" cellspacing="0" style="border-top:solid 4px #15a0dd;font-size:1;margin:0px auto;width:550px;" role="presentation" width="550px"
              >
                <tr>
                  <td style="height:0;line-height:0;">
                    &nbsp;
                  </td>
                </tr>
              </table>
            <![endif]-->
                          </td>
                        </tr>
                        <tr>
                          <td align="left" style="font-size:0px;padding:10px 25px;word-break:break-word;">
                            <div style="font-family:helvetica;font-size:16px;line-height:1;text-align:left;color:black;"> Thank you for using our banking services. </div>
                          </td>
                        </tr>
                      </table>
                    </div>
                    <!--[if mso | IE]>
                  </td>
                
              </tr>
            
                        </table>
                      <![endif]-->
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <!--[if mso | IE]>
                </td>
              </tr>
            </table>
            <![endif]-->
        </div>
      </body>
      
      </html>`,
    };

    await transporter.sendMail(mailOptions);
  }

  async function setTransferHistory(
    senderId,
    recipientId,
    amountMoney,
    transferTitle,
    authorizationKey,
    currencyId,
  ) {
    try {
      return Transaction.create({
        id_sender: senderId,
        id_recipient: recipientId,
        date_time: getTodayDate(),
        amount_money: amountMoney,
        id_currency: currencyId,
        transfer_title: transferTitle,
        authorization_key: authorizationKey,
        authorization_status: setAuthorizationStatus(0),
      });
    } catch (e) {
      /* just ignore */
    }
  }

  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return next(newError(422, errors.array()));
  }

  Bill.findOne({
    where: {
      account_bill: req.body.account_bill,
    },
  }).then(isAccountBill => {
    if (isAccountBill) {
      const recipientId = isAccountBill.id_owner;
      const authorizationKey = setAuthorizationKey();
      const senderId = req.body.id_sender;
      const amountMoney = req.body.amount_money;
      const transferTitle = req.body.transfer_title;

      if (recipientId !== senderId) {
        Bill.findOne({
          where: {
            id_owner: senderId,
          },
        }).then(async isAvailableFunds => {
          if (isAvailableFunds) {
            const senderAvailableFunds = isAvailableFunds.available_funds;
            const currencyId = await getCurrencyId(senderId);

            if (senderAvailableFunds >= amountMoney && amountMoney > 0) {
              Transaction.findOne({
                where: {
                  id_sender: senderId,
                  id_recipient: recipientId,
                  amount_money: amountMoney,
                  id_currency: currencyId,
                  transfer_title: transferTitle,
                  authorization_key: authorizationKey,
                  authorization_status: setAuthorizationStatus(0),
                },
                order: [['date_time', 'DESC']],
              }).then(async isAuthorizationKey => {
                if (!isAuthorizationKey) {
                  await setTransferHistory(
                    senderId,
                    recipientId,
                    amountMoney,
                    transferTitle,
                    authorizationKey,
                    currencyId,
                  );

                  sendAuthorizationKey(
                    senderId,
                    recipientId,
                    amountMoney,
                    authorizationKey,
                    currencyId,
                  ).catch(() => {
                    /* just ignore */
                  });

                  return res.status(200).json({ success: true });
                }
                return res.status(200).json({
                  error: 'Authorization key has been sent',
                  success: false,
                });
              });
            } else {
              return res.status(200).json({
                error: 'Sender does not have enough money',
                success: false,
              });
            }
          } else {
            return res
              .status(200)
              .json({ error: 'Id sender doesnt exist', success: false });
          }
        });
      } else {
        return res
          .status(200)
          .json({ error: 'Attempt payment to myself', success: false });
      }
    } else {
      return res
        .status(200)
        .json({ error: 'Recipient does not exist', success: false });
    }
  });
};

exports.getRecipientdata = (req, res, next) => {
  function setAuthorizationStatus(status) {
    const authorizationStatus = status;
    return authorizationStatus;
  }
  const errors = validationResult(req);
  const id_recipient = req.params.recipientId;

  if (!errors.isEmpty()) {
    return next(newError(422, errors.array()));
  }

  Transaction.findAll({
    limit: 4,
    where: {
      id_recipient,
      authorization_status: setAuthorizationStatus(1),
    },
    attributes: [
      'amount_money',
      'date_time',
      'id_recipient',
      'id_sender',
      'transfer_title',
    ],
    order: [['date_time', 'DESC']],
    include: [
      {
        model: User,
        as: 'getSenderdata',
        where: { id: db.Sequelize.col('transaction.id_sender') },
        attributes: ['name', 'surname'],
      },
      {
        model: Currency,
        where: { id: db.Sequelize.col('transaction.id_sender') },
        attributes: ['currency'],
      },
    ],
  })
    .then(transactions => {
      res.send(transactions);
    })
    .catch(error => {
      next(newError(500, error));
    });
};

exports.getSenderdata = (req, res, next) => {
  function setAuthorizationStatus(status) {
    const authorizationStatus = status;
    return authorizationStatus;
  }
  const errors = validationResult(req);
  const id_sender = req.params.senderId;

  if (!errors.isEmpty()) {
    return next(newError(422, errors.array()));
  }

  Transaction.findAll({
    limit: 4,
    where: {
      id_sender,
      authorization_status: setAuthorizationStatus(1),
    },
    attributes: [
      'amount_money',
      'date_time',
      'id_recipient',
      'id_sender',
      'transfer_title',
    ],
    order: [['date_time', 'DESC']],
    include: [
      {
        model: User,
        as: 'getRecipientdata',
        where: { id: db.Sequelize.col('transaction.id_sender') },
        attributes: ['name', 'surname'],
      },
      {
        model: Currency,
        where: { id: db.Sequelize.col('transaction.id_sender') },
        attributes: ['currency'],
      },
    ],
  })
    .then(transactions => {
      res.send(transactions);
    })
    .catch(error => {
      next(newError(500, error));
    });
};

exports.getTransactionsdata = (req, res, next) => {
  function setAuthorizationStatus(status) {
    const authorizationStatus = status;
    return authorizationStatus;
  }

  const errors = validationResult(req);
  const userId = req.body.userId;
  const offset = req.body.offset;

  if (!errors.isEmpty()) {
    return next(newError(422, errors.array()));
  }

  Transaction.findAndCountAll({
    where: {
      [Op.or]: [{ id_recipient: userId }, { id_sender: userId }],
      authorization_status: setAuthorizationStatus(1),
    },
    attributes: [
      'amount_money',
      'date_time',
      'id_recipient',
      'id_sender',
      'transfer_title',
    ],
    order: [['date_time', 'DESC']],
    limit: 12,
    offset,
    include: [
      {
        model: User,
        as: 'getSenderdata',
        where: { id: db.Sequelize.col('transaction.id_sender') },
        attributes: ['name', 'surname'],
        include: [
          {
            model: Bill,
            attributes: ['account_bill'],
          },
        ],
      },
      {
        model: User,
        as: 'getRecipientdata',
        where: { id: db.Sequelize.col('transaction.id_sender') },
        attributes: ['name', 'surname'],
        include: [
          {
            model: Bill,
            attributes: ['account_bill'],
          },
        ],
      },
      {
        model: Currency,
        where: { id: db.Sequelize.col('transaction.id_sender') },
        attributes: ['currency'],
      },
    ],
  })
    .then(transactions => {
      res.send(transactions);
    })
    .catch(error => {
      next(newError(500, error));
    });
};

exports.getAuthorizationKey = (req, res, next) => {
  const userId = req.body.id_sender;
  const recipientId = req.body.recipient_id;
  const amountMoney = req.body.amount_money;
  const transferTitle = req.body.transfer_title;
  const errors = validationResult(req);

  function setAuthorizationStatus(status) {
    const authorizationStatus = status;
    return authorizationStatus;
  }

  if (!errors.isEmpty()) {
    return next(newError(422, errors.array()));
  }

  Transaction.findOne({
    where: {
      id_sender: userId,
      id_recipient: recipientId,
      transfer_title: transferTitle,
      amount_money: amountMoney,
      authorization_status: setAuthorizationStatus(0),
    },
    attributes: ['authorization_key'],
    order: [['date_time', 'DESC']],
  })
    .then(isAuthorizationKey => {
      if (isAuthorizationKey) {
        const authorizationKey = isAuthorizationKey.authorization_key;
        res.status(200).json({ authorizationKey, success: true });
      }
    })
    .catch(error => {
      next(newError(500, error));
    });
};
