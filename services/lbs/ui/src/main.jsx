import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import axios from 'axios'
import { getTimezoneName } from './utils/date'

// Globably inject timezone to all API requests
axios.defaults.headers.common['X-Timezone'] = getTimezoneName();

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
)
