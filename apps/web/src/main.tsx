import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ClientProvider } from '@solana/react';
import { walletClient } from './walletSdk';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ClientProvider client={walletClient}><App /></ClientProvider></React.StrictMode>,
);
