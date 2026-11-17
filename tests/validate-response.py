"""Validate actual offline HTTP/domain responses against the frozen OpenAPI."""
import json, sys, yaml
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource
spec=yaml.safe_load(open('docs/openapi.yaml'))
uri='urn:soldbench:actual-response'
registry=Registry().with_resource(uri,Resource.from_contents({'$schema':'https://json-schema.org/draft/2020-12/schema',**spec}))
for schema,value in json.load(sys.stdin):
    Draft202012Validator({'$ref':uri+'#/components/schemas/'+schema},registry=registry,format_checker=FormatChecker()).validate(value)
