package com.bridgekit.example.bridgekit

import android.util.Log
import com.bridgekit.example.generated.BridgekitDemoHost
import com.bridgekit.example.generated.PingParams
import com.bridgekit.example.generated.PingResult
import com.bridgekit.example.generated.SayParams
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.isActive

private const val TAG = "BridgeKitDemo"

/**
 * Native implementation of the bridgekit.demo-host contract.
 *
 * Validates:
 *   - Scenario 1: ping (Async)
 *   - Scenario 2: ticker (Stream, native→JS)
 *   - Scenario 3: counter (State) + increment (Async)
 *   - Scenario 4: say (Void, JS→native) + echoes (Stream, round-trip)
 *
 * say() receives text from JS and pushes it into the internal shared flow.
 * echoes() maps each incoming text to its UPPERCASE equivalent, so callers
 * on the JS side can subscribe and receive the echo of every say() call.
 */
class DemoHostImpl : BridgekitDemoHost {

    override val counter: MutableStateFlow<Double> = MutableStateFlow(0.0)

    // Backing channel for the say→echoes round-trip.
    // replay=1 so late subscribers see the most-recent value immediately.
    private val _sayChannel = MutableSharedFlow<String>(replay = 1, extraBufferCapacity = 64)

    override suspend fun ping(params: PingParams): PingResult {
        Log.i(TAG, "ping received: ${params.message}")
        return PingResult(
            reply = "pong: ${params.message}",
            epoch = System.currentTimeMillis().toDouble(),
        )
    }

    override suspend fun increment(): Double {
        val next = counter.value + 1.0
        counter.value = next
        Log.i(TAG, "counter incremented to $next")
        return next
    }

    /**
     * Void marker — JS fires text at native; no return value expected.
     * Pushes the text into [_sayChannel] so [echoes] can re-emit it.
     */
    override fun say(params: SayParams) {
        Log.i(TAG, "say received: ${params.text}")
        _sayChannel.tryEmit(params.text)
    }

    override fun ticker(): Flow<Double> = flow {
        var tick = 0.0
        while (currentCoroutineContext().isActive) {
            emit(tick)
            Log.i(TAG, "ticker emit: $tick")
            tick += 1.0
            delay(1_000)
        }
    }

    /**
     * Stream marker — emits UPPERCASED echo of each text received via [say].
     * The bidirectional round-trip: JS says → native echoes back via stream.
     */
    override fun echoes(): Flow<String> = _sayChannel.map { text ->
        val echo = text.uppercase()
        Log.i(TAG, "echoes emit: $echo")
        echo
    }
}
