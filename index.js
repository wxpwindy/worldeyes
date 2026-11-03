import { createApp } from './app.js'

const port = Number(process.env.PORT || 3000)
const app = createApp()

const server = app.listen(port, '127.0.0.1', () => {
    console.log(`Worldeyes is running at http://127.0.0.1:${port}`)
})
server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is busy. Start with PORT=${port + 1} npm start.` : error.message)
    process.exitCode = 1
})
