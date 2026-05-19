#!/usr/bin/env node
const jwt = require('jsonwebtoken');

const secret =
  process.env.AUTH_SECRET ??
  process.env.NEXTAUTH_SECRET ??
  '86ea1bf8627e69bb503c02e1077831f8bf39ea3ab240fada9b941b6b8d61f231';

const token = jwt.sign(
  { sub: 'dashboard-home-tests', name: 'dashboard-home-tests' },
  secret,
  { expiresIn: '5m' },
);

process.stdout.write(token);
