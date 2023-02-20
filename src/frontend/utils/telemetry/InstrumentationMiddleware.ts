import { NextApiHandler } from 'next';
import { context, Exception, propagation, Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';

const InstrumentationMiddleware = (handler: NextApiHandler, route?: string): NextApiHandler => {
  return async (request, response) => {
    const { headers, method, url = '', httpVersion } = request;
    const [target] = url.split('?');

    const syntheticSpan = trace.getSpan(context.active()) as Span;
    const tracer = trace.getTracer('@opentelemetry/instrumentation-http');
    const attributes = {
      'app.synthetic_request': true,
      [SemanticAttributes.HTTP_TARGET]: target,
      [SemanticAttributes.HTTP_STATUS_CODE]: response.statusCode,
      [SemanticAttributes.HTTP_METHOD]: method,
      [SemanticAttributes.HTTP_USER_AGENT]: headers['user-agent'] || '',
      [SemanticAttributes.HTTP_URL]: `http://${headers.host}${url}`,
      [SemanticAttributes.HTTP_FLAVOR]: httpVersion,
      'http.request.headers': JSON.stringify(request.headers)
    };
    
    if (request.body) {
      attributes['http.request.body'] = JSON.stringify(request.body)
    }

    if (route) {
      attributes[SemanticAttributes.HTTP_ROUTE] = route;
    }

    const span = tracer.startSpan(`HTTP ${method}`, {
      root: true,
      kind: SpanKind.SERVER,
      links: [{ context: syntheticSpan.spanContext() }],
      attributes,
    });

    try {
      const origJson = response.json
      response.json = function(this, body: any) {
        if (body) {
          span.setAttribute('http.response.body', JSON.stringify(body));
        }
        return origJson.apply(this, [body]);
      } 

      response.setHeader('traceresponse', `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
      await runWithSpan(span, async () => handler(request, response));
      span.setAttribute('http.response.headers', JSON.stringify(response.getHeaders()));
    } catch (error) {
      span.recordException(error as Exception);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  };
};

async function runWithSpan(parentSpan: Span, fn: () => Promise<unknown>) {
  const ctx = trace.setSpan(context.active(), parentSpan);

  try {
    return await context.with(ctx, fn);
  } catch (error) {
    parentSpan.recordException(error as Exception);
    parentSpan.setStatus({ code: SpanStatusCode.ERROR });

    throw error;
  }
}

export default InstrumentationMiddleware;
